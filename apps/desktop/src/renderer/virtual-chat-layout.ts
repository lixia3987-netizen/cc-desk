export interface VirtualChatRange {
  /** Exclusive end; spacer heights cover every item outside this range. */
  start: number;
  end: number;
  before: number;
  after: number;
}

/** Height bookkeeping is keyed by message identity, so prepends and edits can reuse it. */
export class VirtualChatLayout {
  private ids: readonly string[] = [];
  private indices = new Map<string, number>();
  private measurements = new Map<string, number>();
  private offsets: number[] = [0];
  private dirty = false;
  readonly estimatedHeight: number;

  constructor(estimatedHeight = 120) {
    this.estimatedHeight = Number.isFinite(estimatedHeight) && estimatedHeight > 0 ? estimatedHeight : 120;
  }

  get length(): number { return this.ids.length; }
  get totalHeight(): number { this.rebuild(); return this.offsets[this.ids.length]; }

  setItems(ids: readonly string[]): boolean {
    if (ids.length === this.ids.length && ids.every((id, index) => id === this.ids[index])) return false;
    this.ids = [...ids];
    this.indices = new Map(ids.map((id, index) => [id, index]));
    for (const id of this.measurements.keys()) if (!this.indices.has(id)) this.measurements.delete(id);
    this.dirty = true;
    return true;
  }

  measure(id: string, height: number): boolean {
    if (!this.indices.has(id) || !Number.isFinite(height) || height <= 0) return false;
    const previous = this.measurements.get(id) ?? this.estimatedHeight;
    if (Math.abs(previous - height) < 0.5) return false;
    this.measurements.set(id, height);
    this.dirty = true;
    return true;
  }

  resetMeasurements(): boolean {
    if (!this.measurements.size) return false;
    this.measurements.clear();
    this.dirty = true;
    return true;
  }

  indexOf(id: string): number { return this.indices.get(id) ?? -1; }

  offset(index: number): number {
    this.rebuild();
    return this.offsets[Math.max(0, Math.min(this.ids.length, Math.floor(index) || 0))];
  }

  size(index: number): number {
    const id = this.ids[index];
    return id === undefined ? 0 : this.measurements.get(id) ?? this.estimatedHeight;
  }

  /** The row containing an offset; outside offsets resolve to the nearest row. */
  indexAt(offset: number): number {
    this.rebuild();
    let low = 0, high = this.ids.length;
    const target = Number.isFinite(offset) ? Math.max(0, offset) : offset === Infinity ? this.totalHeight : 0;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.offsets[middle + 1] <= target) low = middle + 1;
      else high = middle;
    }
    return Math.min(low, Math.max(0, this.ids.length - 1));
  }

  range(top: number, viewportHeight: number, overscan = 600, minRows = 8): VirtualChatRange {
    if (!this.ids.length) return { start: 0, end: 0, before: 0, after: 0 };
    const position = Number.isFinite(top) ? Math.max(0, top) : top === Infinity ? this.totalHeight : 0;
    const height = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
    const buffer = Number.isFinite(overscan) ? Math.max(0, overscan) : 0;
    let start = this.indexAt(Math.max(0, position - buffer));
    let end = Math.min(this.ids.length, this.indexAt(position + height + buffer) + 1);
    const minimum = Math.min(this.ids.length, Math.max(1, Number.isFinite(minRows) ? Math.floor(minRows) : 8));
    const missing = Math.max(0, minimum - (end - start));
    start -= Math.min(start, Math.ceil(missing / 2));
    end = Math.min(this.ids.length, Math.max(end, start + minimum));
    start = Math.max(0, Math.min(start, end - minimum));
    return { start, end, before: this.offset(start), after: this.totalHeight - this.offset(end) };
  }

  private rebuild(): void {
    if (!this.dirty) return;
    this.offsets = [0];
    for (const id of this.ids) this.offsets.push(this.offsets[this.offsets.length - 1] + (this.measurements.get(id) ?? this.estimatedHeight));
    this.dirty = false;
  }
}
