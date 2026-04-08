let stored: { username: string; password: string } | null = null;

export async function setGenericPassword(
  username: string,
  password: string,
  _options?: unknown,
): Promise<boolean> {
  stored = { username, password };
  return true;
}

export async function getGenericPassword(
  _options?: unknown,
): Promise<false | { username: string; password: string }> {
  return stored ?? false;
}

export async function resetGenericPassword(_options?: unknown): Promise<boolean> {
  stored = null;
  return true;
}
