export type Snapshot<T> = { timestamp: number; data: T };

export class Timeline<T> {
  maxLen: number;
  private items: Snapshot<T>[] = [];

  constructor(maxLen = 1000) {
    this.maxLen = maxLen;
  }

  append(ts: number, data: T) {
    this.items.push({ timestamp: ts, data });
    if (this.items.length > this.maxLen) this.items.shift();
  }

  get(index: number) {
    return this.items[index];
  }

  last() {
    return this.items[this.items.length - 1];
  }

  length() {
    return this.items.length;
  }

  asArray() {
    return this.items.slice();
  }
}

export default Timeline;
