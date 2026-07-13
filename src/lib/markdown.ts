type MarkdownTreeNode = {
  children?: MarkdownTreeNode[];
  type: string;
  value?: string;
};

const SAFE_BREAK_TAG = /^<br\s*\/?\s*>$/i;

function replaceSafeBreakTags(node: MarkdownTreeNode) {
  if (!node.children) return;

  node.children = node.children.map((child) => {
    if (child.type === 'html' && SAFE_BREAK_TAG.test(child.value?.trim() || '')) {
      return { type: 'break' };
    }

    replaceSafeBreakTags(child);
    return child;
  });
}

/** Render legacy <br> tags without enabling arbitrary raw HTML. */
export function remarkSafeBreaks() {
  return (tree: MarkdownTreeNode) => replaceSafeBreakTags(tree);
}
