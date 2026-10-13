/**
 * shadcn/ui's standard `cn` class-name helper (spec 0016 item 4 scaffold):
 * merges conditional `clsx` classes and de-dupes conflicting Tailwind
 * utilities via `tailwind-merge`. Every copied-in shadcn component imports
 * this from `lib/utils` — item 6's generative cards will too.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
