const TOOL_DIRECTIVE = new RegExp(
  [
    String.raw`^\s*eslint(-disable|-enable|-disable-line|-disable-next-line)?(\s|$)`,
    String.raw`^\s*global(s)?\s`,
    String.raw`^\s*@ts-(check|nocheck|expect-error|ignore)\b`,
    String.raw`^\s*\*?\s*@vitest-environment\s`,
    String.raw`^\s*prettier-ignore\b`,
    String.raw`^\s*(c8|v8|istanbul)\s+ignore\b`,
    String.raw`^/\s*<reference\s`,
  ].join("|"),
);

const JSDOC_TYPE_ANNOTATION = /^\*\s*@(type|satisfies|typedef|import)\s*\{[^]*\}\s*$/;

function isToolDirective(comment) {
  return TOOL_DIRECTIVE.test(comment.value) || JSDOC_TYPE_ANNOTATION.test(comment.value.trim());
}

module.exports = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow comments other than tool directives; record decisions in docs/adr instead.",
    },
    schema: [],
    messages: {
      noComment:
        "Comments are not allowed. Delete it if the code already says it or it is stale; record a non-obvious decision in docs/adr/; file an issue for a known shortcut. See /delete-comment.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type === "Shebang" || isToolDirective(comment)) continue;
          context.report({ loc: comment.loc, messageId: "noComment" });
        }
      },
    };
  },
};
