/**
 * Rule to prevent dangerouslySetInnerHTML in JSX.
 *
 * In a React codebase the XSS risk is not HTML script tags (which ESLint
 * cannot see) but dangerouslySetInnerHTML bypassing React's built-in escaping.
 * All HTML rendering must go through the DOMPurify sanitize() wrapper in
 * packages/web/src/lib/sanitize.ts instead.
 */

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Prevent dangerouslySetInnerHTML — use the DOMPurify sanitize() wrapper instead',
      category: 'Security',
      recommended: true,
    },
    fixable: null,
    schema: [],
    messages: {
      noInlineScript: 'dangerouslySetInnerHTML is not allowed — use the DOMPurify sanitize() wrapper from @/lib/sanitize instead.',
    },
  },

  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name && node.name.name === 'dangerouslySetInnerHTML') {
          context.report({ node, messageId: 'noInlineScript' });
        }
      },
    };
  },
};
