// An in-memory R2 bucket for tests: the calls src/dead-letters.ts makes (put, get, head, list
// with prefix and cursor, delete), with text bodies and custom metadata.
export function createTestR2(): R2Bucket {
  const objects = new Map<
    string,
    { body: string; uploaded: Date; customMetadata: Record<string, string> }
  >();
  const object = (key: string) => {
    const stored = objects.get(key);
    if (!stored) return null;
    return {
      key,
      size: stored.body.length,
      uploaded: stored.uploaded,
      customMetadata: stored.customMetadata,
      text: async () => stored.body,
      json: async () => JSON.parse(stored.body),
    };
  };

  const bucket = {
    async put(
      key: string,
      body: string,
      options: { customMetadata?: Record<string, string> } = {},
    ) {
      objects.set(key, {
        body,
        uploaded: new Date(),
        customMetadata: options.customMetadata ?? {},
      });
      return object(key);
    },
    get: async (key: string) => object(key),
    head: async (key: string) => object(key),
    async delete(keys: string | string[]) {
      for (const key of [keys].flat()) objects.delete(key);
    },
    async list({ prefix = "", cursor, limit = 1000 }: R2ListOptions = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return {
        objects: page.map(object),
        truncated,
        cursor: truncated ? String(start + limit) : undefined,
        delimitedPrefixes: [],
      };
    },
  };
  return bucket as unknown as R2Bucket;
}
