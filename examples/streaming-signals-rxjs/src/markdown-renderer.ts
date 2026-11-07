import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

// #region markdown-renderer
export interface IncrementalMarkdownResult {
  /** Sanitized HTML for completed paragraphs/blocks that will no longer change. */
  readonly committedHtml: string;
  /** Sanitized HTML for the active, still-streaming tail block (e.g. open code fence or paragraph). */
  readonly activeTailHtml: string;
  /** Combined sanitized HTML safe to bind into the DOM. */
  readonly fullSanitizedHtml: string;
  /** Number of completed top-level blocks cached so far. */
  readonly cachedBlockCount: number;
}

const STREAM_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'a', 'ul', 'ol', 'li', 'blockquote',
    'code', 'pre', 'em', 'strong', 'del', 'hr', 'br',
    'span', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    code: ['class'],
    pre: ['class', 'tabindex'],
    span: ['class'],
    th: ['align'],
    td: ['align'],
  },
  // Allow only https and mailto schemes; relative paths (/cases/..., #anchor) remain allowed.
  // Rejects javascript:, data:, vbscript:, file:, and plain http: links.
  allowedSchemes: ['https', 'mailto'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
};

/**
 * Balances an unclosed Markdown code fence (` ``` `) in the active streaming tail
 * so partial code blocks render as `<pre><code>` during streaming instead of
 * spilling raw syntax into surrounding paragraphs.
 */
export function stabilizeStreamingTail(tailMarkdown: string): string {
  const fenceMatches = tailMarkdown.match(/^```/gm);
  if (fenceMatches && fenceMatches.length % 2 === 1) {
    return `${tailMarkdown}\n\`\`\``;
  }
  return tailMarkdown;
}

export function sanitizeStreamHtml(dirtyHtml: string): string {
  return sanitizeHtml(dirtyHtml, STREAM_SANITIZE_OPTIONS);
}

/**
 * Bounded incremental Markdown renderer.
 *
 * Instead of re-parsing and sanitizing the entire accumulated transcript on every
 * 32ms batch tick (O(N^2) over a long response), this renderer splits stable
 * completed blocks from the active tail. Completed blocks outside open code fences
 * are parsed and sanitized once; only the active tail is re-parsed on each tick.
 */
export class IncrementalMarkdownRenderer {
  private cachedPrefixText = '';
  private cachedCommittedHtml = '';
  private cachedBlockCount = 0;

  reset(): void {
    this.cachedPrefixText = '';
    this.cachedCommittedHtml = '';
    this.cachedBlockCount = 0;
  }

  render(fullMarkdown: string): IncrementalMarkdownResult {
    if (!fullMarkdown) {
      this.reset();
      return {
        committedHtml: '',
        activeTailHtml: '',
        fullSanitizedHtml: '',
        cachedBlockCount: 0,
      };
    }

    // If the text did not grow from the previous prefix (e.g., new request), reset cache.
    if (!fullMarkdown.startsWith(this.cachedPrefixText)) {
      this.reset();
    }

    const { stablePrefix, activeTail, newStableBlocks } = this.splitStablePrefix(
      fullMarkdown,
      this.cachedPrefixText.length,
    );

    if (newStableBlocks.length > 0) {
      const newlyRendered = newStableBlocks
        .map((block) => sanitizeStreamHtml(marked.parse(block, { async: false }) as string))
        .join('\n');
      this.cachedCommittedHtml = this.cachedCommittedHtml
        ? `${this.cachedCommittedHtml}\n${newlyRendered}`
        : newlyRendered;
      this.cachedPrefixText = stablePrefix;
      this.cachedBlockCount += newStableBlocks.length;
    }

    const stabilizedTail = stabilizeStreamingTail(activeTail);
    const activeTailHtml = stabilizedTail.trim()
      ? sanitizeStreamHtml(marked.parse(stabilizedTail, { async: false }) as string)
      : '';

    const fullSanitizedHtml =
      this.cachedCommittedHtml && activeTailHtml
        ? `${this.cachedCommittedHtml}\n${activeTailHtml}`
        : this.cachedCommittedHtml || activeTailHtml;

    return {
      committedHtml: this.cachedCommittedHtml,
      activeTailHtml,
      fullSanitizedHtml,
      cachedBlockCount: this.cachedBlockCount,
    };
  }

  private splitStablePrefix(
    fullMarkdown: string,
    alreadyCachedLength: number,
  ): {
    stablePrefix: string;
    activeTail: string;
    newStableBlocks: string[];
  } {
    const uncachedSlice = fullMarkdown.slice(alreadyCachedLength);
    const lines = uncachedSlice.split('\n');
    let inFence = false;
    let currentBlockLines: string[] = [];
    const newStableBlocks: string[] = [];
    let consumedChars = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trimStart().startsWith('```')) {
        inFence = !inFence;
      }
      currentBlockLines.push(line);

      // A double newline outside a code fence marks a completed block boundary,
      // provided there is at least one more line after it.
      const isBlankLine = line.trim() === '';
      const hasMoreLines = i < lines.length - 1;
      if (!inFence && isBlankLine && hasMoreLines && currentBlockLines.length > 1) {
        const blockText = currentBlockLines.join('\n') + '\n';
        newStableBlocks.push(blockText);
        consumedChars += blockText.length;
        currentBlockLines = [];
      }
    }

    const stablePrefix = fullMarkdown.slice(0, alreadyCachedLength + consumedChars);
    const activeTail = fullMarkdown.slice(alreadyCachedLength + consumedChars);

    return { stablePrefix, activeTail, newStableBlocks };
  }
}

export interface ScrollAnchorState {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/**
 * Predictable scroll-anchoring helper: keeps pinning to the bottom only while
 * the user is within `thresholdPx` of the bottom edge. As soon as the user scrolls
 * up to read earlier paragraphs, auto-scrolling pauses until they return to the bottom.
 */
export function shouldStickToBottom(
  state: ScrollAnchorState,
  thresholdPx = 48,
): boolean {
  const distanceFromBottom = state.scrollHeight - state.scrollTop - state.clientHeight;
  return distanceFromBottom <= thresholdPx;
}

/**
 * Computes polite screen-reader (`aria-live="polite"`) announcements.
 * Instead of announcing every token (which overwhelms assistive technologies),
 * announces lifecycle transitions (`Started`, `Completed`, `Cancelled`, `Failed`)
 * and throttled sentence-level progress updates.
 */
export class AriaLiveAnnouncer {
  private lastAnnouncedLength = 0;

  announceStatusChange(
    status: 'idle' | 'streaming' | 'done' | 'cancelled' | 'failed',
    text: string,
    errorDetail?: string,
  ): string | null {
    switch (status) {
      case 'idle':
        this.lastAnnouncedLength = 0;
        return null;
      case 'streaming':
        if (this.lastAnnouncedLength === 0 && text.length === 0) {
          return 'Assistant is generating a response.';
        }
        // Only emit an intermediate polite update when at least 160 characters
        // and a sentence boundary have accumulated since the last announcement.
        if (text.length - this.lastAnnouncedLength >= 160 && /[.!?]\s$/.test(text)) {
          const delta = text.slice(this.lastAnnouncedLength).trim();
          this.lastAnnouncedLength = text.length;
          return delta;
        }
        return null;
      case 'done':
        this.lastAnnouncedLength = text.length;
        return 'Response complete.';
      case 'cancelled':
        return 'Response generation stopped.';
      case 'failed':
        return `Response failed: ${errorDetail ?? 'unknown error'}`;
    }
  }
}
// #endregion markdown-renderer

