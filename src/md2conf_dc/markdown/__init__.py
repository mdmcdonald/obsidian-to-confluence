"""Semantic Markdown parsing for Confluence rendering.

This package deliberately exposes immutable values rather than markdown-it tokens.  It
is safe for a CLI, GUI, or embedded caller to parse once and inspect diagnostics before
deciding whether to render or publish.
"""

from md2conf_dc.markdown.ir import Document
from md2conf_dc.markdown.parser import ParseResult, parse_markdown

__all__ = ["Document", "ParseResult", "parse_markdown"]
