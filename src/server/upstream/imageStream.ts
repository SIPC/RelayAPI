import "server-only";

function imageIndex(value: Record<string, unknown>) {
  const index = value.image_index ?? value.index ?? value.output_index ?? value.image_id;
  if (typeof index === "number" && Number.isSafeInteger(index) && index >= 0) return String(index);
  if (typeof index === "string" && index.trim()) return index.trim();
}

function imageRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hasImage(value: Record<string, unknown>) {
  return (typeof value.b64_json === "string" && value.b64_json.length > 0) ||
    (typeof value.url === "string" && value.url.length > 0);
}

export class ImageStreamState {
  private expected: number;
  private seen = new Set<string>();
  private completed = new Map<string, number>();
  private anonymous = 0;

  constructor(requestedCount: unknown = 1) {
    const count = Number(requestedCount);
    this.expected = Number.isSafeInteger(count) && count > 0 ? count : 1;
  }

  observe(type: string, value: Record<string, unknown>) {
    if (!/^image_(?:generation|edit)\./.test(type)) return;
    const index = imageIndex(value);
    if (index !== undefined) this.seen.add(index);
    const items = Array.isArray(value.data) ? value.data.map(imageRecord) : undefined;
    for (const item of items || []) {
      const itemIndex = imageIndex(item);
      if (itemIndex !== undefined) this.seen.add(itemIndex);
    }
    if (!type.endsWith(".completed")) return;
    if (!items) { if (hasImage(value)) this.complete(index, 1); return; }
    let images = 0;
    for (const [position, image] of items.entries()) {
      if (!hasImage(image)) continue;
      images++;
      // Native data arrays identify otherwise unlabelled images by their position.
      this.complete(imageIndex(image) ?? (items.length === 1 ? index : undefined) ?? String(position), 1);
    }
    // An indexed aggregate is terminal metadata, not an extra image to count.
    if (images && index !== undefined && !this.completed.has(index)) this.completed.set(index, 0);
  }

  get isComplete() {
    const completedCount = [...this.completed.values()].reduce((sum, count) => sum + count, this.anonymous);
    return completedCount >= this.expected && [...this.seen].every((index) => this.completed.has(index));
  }

  private complete(index: string | undefined, count: number) {
    if (index === undefined) this.anonymous += count;
    else this.completed.set(index, Math.max(this.completed.get(index) ?? 0, count));
  }
}
