from pathlib import Path

from md2conf_dc.markdown.ir import (
    Anchor,
    Callout,
    CodeBlock,
    Directive,
    Highlight,
    Image,
    InlineCode,
    InlineMath,
    MacroName,
    MathBlock,
    Paragraph,
    TaskList,
    Text,
    WikiLink,
)
from md2conf_dc.markdown.parser import parse_markdown


def test_parse_obsidian_nodes_without_touching_code() -> None:
    source = (
        "Text ==marked== %%removed%% [[Page#Heading|Alias]] "
        "![[picture.png|Diagram|320x200]] ^block\n\n"
        "\u0060%%kept%% [[literal]] ==literal==\u0060\n\n"
        "~~~text\n%%kept%% [[literal]] ==literal==\n~~~\n"
    )

    result = parse_markdown(source, path=Path("notes/example.md"))

    assert result.ok
    first = result.document.blocks[0]
    assert isinstance(first, Paragraph)
    assert any(isinstance(node, Highlight) for node in first.children)
    assert any(isinstance(node, WikiLink) for node in first.children)
    image = next(node for node in first.children if isinstance(node, Image))
    assert (image.width, image.height, image.alt_text) == (320, 200, "Diagram")
    assert isinstance(result.document.blocks[1], Anchor)
    code = result.document.blocks[-1]
    assert isinstance(code, CodeBlock)
    assert "%%kept%% [[literal]] ==literal==" in code.value


def test_tasks_callouts_and_typed_directive() -> None:
    source = (
        "- [x] complete\n- [ ] open\n\n"
        "> [!WARNING]- Read this\n> Rich **body**\n\n"
        "::: confluence:children {depth=2 sort=title}\n:::\n"
    )

    result = parse_markdown(source, path=Path("example.md"))

    assert result.ok
    tasks = result.document.blocks[0]
    assert isinstance(tasks, TaskList)
    assert [item.task_checked for item in tasks.items] == [True, False]
    callout = result.document.blocks[1]
    assert isinstance(callout, Callout)
    assert (callout.kind, callout.title, callout.collapsible) == (
        "warning",
        "Read this",
        True,
    )
    directive = result.document.blocks[2]
    assert isinstance(directive, Directive)
    assert directive.name is MacroName.CHILDREN
    assert {item.name: item.value for item in directive.parameters} == {
        "depth": "2",
        "sort": "title",
    }
    assert directive.span.line == 7


def test_unknown_directive_is_a_parse_error() -> None:
    source = "::: confluence:made-up {x=1 x=2}\nbody\n:::\n"

    result = parse_markdown(source, path=Path("bad.md"))

    assert not result.ok
    assert {item.code for item in result.diagnostics} >= {"MD_UNKNOWN_DIRECTIVE"}


def test_comment_text_is_removed_but_surrounding_text_remains() -> None:
    result = parse_markdown("before %%secret%% after\n", path=Path("comment.md"))
    paragraph = result.document.blocks[0]
    assert isinstance(paragraph, Paragraph)
    assert "".join(node.value for node in paragraph.children if isinstance(node, Text)) == (
        "before  after"
    )


def test_multiline_comments_are_removed_across_formatting_but_code_is_protected() -> None:
    source = (
        "before %% hidden\n**also hidden** %% after\n\n"
        "%% not paired before `literal %% code` after %%\n"
    )

    result = parse_markdown(source, path=Path("comments.md"))

    first = result.document.blocks[0]
    assert isinstance(first, Paragraph)
    assert "hidden" not in "".join(node.value for node in first.children if isinstance(node, Text))
    second = result.document.blocks[1]
    assert isinstance(second, Paragraph)
    inline_code = next(node for node in second.children if isinstance(node, InlineCode))
    assert inline_code.value == "literal %% code"


def test_math_is_typed_outside_code() -> None:
    source = "Inline $x + y$ and `literal $z$`.\n\n$$\na^2 + b^2\n$$\n"

    result = parse_markdown(source, path=Path("math.md"))

    assert result.ok
    paragraph = result.document.blocks[0]
    assert isinstance(paragraph, Paragraph)
    assert any(isinstance(node, InlineMath) for node in paragraph.children)
    assert any(isinstance(node, InlineCode) and "$z$" in node.value for node in paragraph.children)
    assert isinstance(result.document.blocks[1], MathBlock)


def test_accessibility_diagnostics_traverse_styled_content() -> None:
    source = (
        "## Start\n\n#### ==Jump==\n\n[ ](target.md)\n\n"
        "First ^duplicate\n\nSecond ^duplicate\n\n"
        "|  |\n| --- |\n| value |\n"
    )

    result = parse_markdown(source, path=Path("accessibility.md"))

    codes = {item.code for item in result.diagnostics}
    assert codes >= {
        "ACCESS_HEADING_LEVEL_SKIPPED",
        "ACCESS_EMPTY_LINK",
        "ACCESS_DUPLICATE_ANCHOR",
        "ACCESS_TABLE_WITHOUT_HEADER",
    }


def test_parser_bounds_hostile_directive_nesting() -> None:
    depth = 40
    source = (
        "\n".join("::: confluence:expand {title=x}" for _ in range(depth))
        + "\nBody\n"
        + "\n".join(":::" for _ in range(depth))
    )
    result = parse_markdown(source, path=Path("nested.md"))
    assert not result.ok
    assert any(diagnostic.code == "MD_DIRECTIVE_DEPTH_LIMIT" for diagnostic in result.diagnostics)
