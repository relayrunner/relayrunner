import { count, exact } from "@/lib/utils";

/** A count in short form ("1.1K"), with the exact number on hover once it's shortened. */
export function Count({ value }: { value: number }) {
  const text = count(value);
  return <span title={value >= 1000 ? exact(value) : undefined}>{text}</span>;
}
