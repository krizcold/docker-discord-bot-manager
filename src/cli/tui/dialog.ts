/** The keys a dialog reads. */
export interface DialogKey {
  upArrow?: boolean;
  downArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
}

/**
 * A Y dialog that scrolls: its question is never cut. Y confirms only once the last line has been on screen, and only
 * from an input that is exactly y or Y; any key that does not scroll cancels.
 */
export class Dialog {
  private top = 0;
  private room = 10;
  private total = 0;
  private seenEnd = false;
  // Whether the newest view showed the last line; the frame may draw twice per render, so only the newest counts.
  private endShown = false;

  /** `text` gives the question's lines for a width; `head` stays above it. */
  constructor(
    private readonly head: string[],
    private readonly text: (width: number) => string[],
    readonly yes: string,
    readonly run: () => void,
    /** A Space key the dialog takes (a toggle in its text), with its key bar label. */
    private readonly space?: { label: string; press: () => void },
  ) {}

  /** 'yes' runs the action, 'cancel' closes the dialog, null when the key only scrolled or did nothing. */
  key(input: string, key: DialogKey): 'yes' | 'cancel' | null {
    if (this.endShown) this.seenEnd = true;
    if (this.space && input === ' ') {
      this.space.press();
      return null;
    }
    const page = Math.max(this.room - 1, 1);
    const step = key.upArrow ? -1 : key.downArrow ? 1 : key.pageUp ? -page : key.pageDown ? page : 0;
    if (step !== 0) {
      const last = Math.max(this.total - this.room, 0);
      this.top = Math.max(0, Math.min(Math.min(this.top, last) + step, last));
      return null;
    }
    if (input === 'y' || input === 'Y') return this.seenEnd ? 'yes' : null;
    return 'cancel';
  }

  view(width: number, room: number): { body: string[]; keys: string } {
    const lines = this.text(width);
    const space = Math.max(room - this.head.length, 1);
    this.room = space;
    this.total = lines.length;
    // A draw never moves the stored scroll: the frame's first, taller draw would otherwise leave the second one a line short.
    const top = Math.max(0, Math.min(this.top, Math.max(lines.length - space, 0)));
    this.endShown = top + space >= lines.length;
    const scrolls = lines.length > space;
    const toggle = this.space ? [this.space.label] : [];
    const keys = this.seenEnd || this.endShown
      ? [this.yes, ...(scrolls ? ['Up/Down Scroll'] : []), ...toggle, 'any other key Cancel'].join('  ')
      : ['Down More', ...toggle, 'any other key Cancel'].join('  ');
    return { body: [...this.head, ...lines.slice(top, top + space)], keys };
  }
}
