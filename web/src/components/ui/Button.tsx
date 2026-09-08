import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "@/lib/format";
import { IconSpinner } from "./Icons";

/** primary = lime, secondary = ink, tertiary = white + line-2, white = white on dark, ghost, text. */
type Variant = "primary" | "secondary" | "tertiary" | "white" | "ghost" | "text";
type Size = "sm" | "md" | "lg";

const variantClass: Record<Variant, string> = {
  primary: "btn btn-primary",
  secondary: "btn btn-secondary",
  tertiary: "btn btn-tertiary",
  white: "btn btn-white",
  ghost: "btn btn-ghost",
  text: "btn-text",
};
const sizeClass: Record<Size, string> = { sm: "btn-sm", md: "", lg: "btn-lg" };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export function Button({ variant = "primary", size = "md", loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      className={cx(variantClass[variant], variant !== "text" && sizeClass[size], className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <IconSpinner width={16} height={16} /> : null}
      {children}
    </button>
  );
}

export function LinkButton({
  href,
  variant = "primary",
  size = "md",
  className,
  children,
}: {
  href: string;
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={cx(variantClass[variant], variant !== "text" && sizeClass[size], className)}>
      {children}
    </Link>
  );
}
