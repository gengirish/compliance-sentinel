import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-cta text-background hover:bg-cta-hover",
        primary: "bg-primary text-white hover:bg-primary/85",
        secondary: "border border-border bg-transparent text-foreground hover:bg-surface-light",
        ghost: "text-muted hover:bg-surface-light hover:text-foreground",
      },
      size: {
        // Both sizes keep a 44px minimum hit target; sm only trims padding and type.
        default: "min-h-11 px-5 py-2.5 text-sm",
        sm: "min-h-11 px-3.5 py-2 text-xs",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = "Button";
