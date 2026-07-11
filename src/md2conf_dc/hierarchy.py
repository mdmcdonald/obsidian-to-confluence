"""Stable folder identities, landing selection, and direct-parent relationships."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from uuid import UUID, uuid5

from md2conf_dc.models import (
    ContentKind,
    Diagnostic,
    FolderNode,
    Severity,
    SourceDocument,
    SourceIdentity,
    SourceKind,
)


@dataclass(frozen=True, slots=True)
class HierarchyResult:
    folders: tuple[FolderNode, ...]
    parent_by_source_id: Mapping[str, str | None]
    folder_by_path: Mapping[str, str]
    page_source_id_by_folder: Mapping[str, str]
    landing_folder_by_source_id: Mapping[str, str]
    diagnostics: tuple[Diagnostic, ...]

    @property
    def ok(self) -> bool:
        return not any(item.severity is Severity.ERROR for item in self.diagnostics)


def build_hierarchy(
    documents: Sequence[SourceDocument],
    *,
    vault_id: str,
    publish_root: PurePosixPath | str = ".",
    preserve_folder_structure: bool = True,
) -> HierarchyResult:
    """Build a hierarchy rooted at configured scope, never at the selected batch."""

    namespace = UUID(vault_id)
    scope = _normalized_scope(publish_root, documents)
    diagnostics: list[Diagnostic] = []
    if not preserve_folder_structure:
        flat_parents: dict[str, str | None] = {
            document.identity.source_id: None for document in documents
        }
        return HierarchyResult(
            (),
            MappingProxyType(flat_parents),
            MappingProxyType({}),
            MappingProxyType({}),
            MappingProxyType({}),
            (),
        )

    scoped: defaultdict[str, list[SourceDocument]] = defaultdict(list)
    outside: list[SourceDocument] = []
    for document in documents:
        relative = PurePosixPath(document.identity.relative_path)
        try:
            in_scope = relative.relative_to(scope) if str(scope) != "." else relative
        except ValueError:
            outside.append(document)
            continue
        if document.frontmatter.content_type is ContentKind.PAGE:
            scoped[in_scope.parent.as_posix()].append(document)

    folder_paths: set[PurePosixPath] = set()
    for directory_text in scoped:
        directory = PurePosixPath(directory_text)
        while str(directory) != ".":
            folder_paths.add(directory)
            directory = directory.parent

    folder_id_by_path = {
        path.as_posix(): str(uuid5(namespace, f"folder:{path.as_posix()}")) for path in folder_paths
    }
    landing_by_folder: dict[str, SourceDocument] = {}
    ordered_folders = sorted(
        folder_paths,
        key=lambda item: (len(item.parts), item.as_posix().casefold(), item.as_posix()),
    )
    for folder in ordered_folders:
        candidates = scoped.get(folder.as_posix(), [])
        landing = _select_landing(folder, candidates, diagnostics)
        if landing is not None:
            landing_by_folder[folder.as_posix()] = landing

    page_source_id_by_folder: dict[str, str] = {}
    landing_folder_by_source_id: dict[str, str] = {}
    for folder_text_key, folder_id_value in folder_id_by_path.items():
        folder_landing = landing_by_folder.get(folder_text_key)
        page_source_id = (
            folder_landing.identity.source_id if folder_landing is not None else folder_id_value
        )
        page_source_id_by_folder[folder_text_key] = page_source_id
        if folder_landing is not None:
            landing_folder_by_source_id[folder_landing.identity.source_id] = folder_id_value

    parents: dict[str, str | None] = {}
    nodes: list[FolderNode] = []
    for folder in ordered_folders:
        folder_text = folder.as_posix()
        folder_id = folder_id_by_path[folder_text]
        parent_path = folder.parent.as_posix()
        parent_id: str | None = (
            None if parent_path == "." else page_source_id_by_folder[parent_path]
        )
        landing = landing_by_folder.get(folder_text)
        children: list[str] = []
        for child_folder, page_source_id in page_source_id_by_folder.items():
            if PurePosixPath(child_folder).parent == folder:
                children.append(page_source_id)
        for document in scoped.get(folder_text, []):
            if landing is None or document.identity.source_id != landing.identity.source_id:
                children.append(document.identity.source_id)
        children.sort()
        identity = SourceIdentity(
            vault_id=str(namespace),
            source_id=folder_id,
            relative_path=folder_text,
            kind=SourceKind.FOLDER,
        )
        nodes.append(
            FolderNode(
                identity=identity,
                relative_path=folder_text,
                final_title=folder.name,
                parent_source_id=parent_id,
                landing_source_id=None if landing is None else landing.identity.source_id,
                children=tuple(children),
            )
        )
        parents[folder_id] = parent_id
        if landing is not None:
            parents[landing.identity.source_id] = parent_id

    for directory_key, folder_documents in scoped.items():
        folder_parent: str | None = (
            None if directory_key == "." else page_source_id_by_folder[directory_key]
        )
        landing = landing_by_folder.get(directory_key)
        for document in folder_documents:
            if landing is not None and document.identity.source_id == landing.identity.source_id:
                continue
            parents[document.identity.source_id] = folder_parent
    for document in outside:
        parents[document.identity.source_id] = None
    for document in documents:
        if document.frontmatter.content_type is ContentKind.BLOGPOST:
            parents[document.identity.source_id] = None

    return HierarchyResult(
        folders=tuple(nodes),
        parent_by_source_id=MappingProxyType(parents),
        folder_by_path=MappingProxyType(folder_id_by_path),
        page_source_id_by_folder=MappingProxyType(page_source_id_by_folder),
        landing_folder_by_source_id=MappingProxyType(landing_folder_by_source_id),
        diagnostics=tuple(diagnostics),
    )


def _select_landing(
    folder: PurePosixPath,
    documents: Sequence[SourceDocument],
    diagnostics: list[Diagnostic],
) -> SourceDocument | None:
    priorities = ("readme.md", "index.md", f"{folder.name.casefold()}.md")
    for expected in priorities:
        matches = [
            document
            for document in documents
            if PurePosixPath(document.identity.relative_path).name.casefold() == expected
        ]
        if len(matches) > 1:
            paths = ", ".join(sorted(item.identity.relative_path for item in matches))
            diagnostics.append(
                Diagnostic(
                    code="HIERARCHY_AMBIGUOUS_LANDING",
                    severity=Severity.ERROR,
                    message=f"folder {folder.as_posix()} has ambiguous landing files: {paths}",
                )
            )
            return None
        if matches:
            return matches[0]
    return None


def _normalized_scope(
    value: PurePosixPath | str, documents: Sequence[SourceDocument]
) -> PurePosixPath:
    path = PurePosixPath(str(value).replace("\\", "/"))
    if path.is_absolute():
        if not documents:
            # The concrete scope is immaterial to an empty hierarchy.  Discovery's
            # zero-source guard remains responsible for preventing orphan actions.
            return PurePosixPath(".")
        document = documents[0]
        relative_parts = PurePosixPath(document.identity.relative_path).parts
        vault_root = document.absolute_path
        for _part in relative_parts:
            vault_root = vault_root.parent
        try:
            relative_scope = Path(str(value)).resolve(strict=False).relative_to(vault_root)
        except ValueError as exc:
            raise ValueError("publish_root is outside the discovered vault") from exc
        path = PurePosixPath(relative_scope.as_posix())
    if ".." in path.parts:
        raise ValueError("publish_root must be a normalized relative path")
    normalized = PurePosixPath(*[part for part in path.parts if part not in {"", "."}])
    return PurePosixPath(".") if not normalized.parts else normalized
