/** A validator for the authenticated, visible representation, never raw storage. */
export async function snapshotTag(json: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  // Weak validators remain valid when the transport compresses the JSON body.
  return `W/"hearth-${hash}"`;
}

export function matchesSnapshot(header: string | undefined, tag: string): boolean {
  if (!header) return false;
  const opaque = tag.replace(/^W\//, '');
  return header.split(',').some(value => {
    const candidate = value.trim();
    return candidate === '*' || candidate.replace(/^W\//, '') === opaque;
  });
}
