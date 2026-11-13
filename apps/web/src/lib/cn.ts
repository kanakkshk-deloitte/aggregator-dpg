import clsx, { type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Joins class names and resolves conflicting Tailwind utilities.
 *
 * Later utilities win, so `bg-red-500` overrides an earlier `bg-blue-500`.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
