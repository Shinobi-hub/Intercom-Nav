/** Joins truthy class names: cx('a', cond && 'b') -> "a b". */
export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}
