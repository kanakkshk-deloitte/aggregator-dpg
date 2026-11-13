'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { buttonClass, type ButtonKind } from './button-class';

export type { ButtonKind } from './button-class';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  kind?: ButtonKind;
  icon?: ReactNode;
}

export function Button({
  kind = 'primary',
  children,
  icon,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button type={type} className={buttonClass(kind, className)} {...rest}>
      {icon}
      {children}
    </button>
  );
}
