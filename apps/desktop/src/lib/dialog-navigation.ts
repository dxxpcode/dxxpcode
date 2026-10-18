export function dialogTabTarget(index: number, length: number, backwards: boolean): number | null {
  if (length <= 0) return null;
  if (index < 0 || index >= length) return backwards ? length - 1 : 0;
  if (backwards && index === 0) return length - 1;
  if (!backwards && index === length - 1) return 0;
  return null;
}
