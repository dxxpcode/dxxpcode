import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-[0.02em] transition-colors",
  {
    variants: {
      variant: {
        secondary: "bg-[var(--surface2)] text-[var(--dim)]",
        outline: "border border-[var(--border)] text-[var(--dim)]",
        success: "bg-[color-mix(in_srgb,var(--green)_12%,transparent)] text-[var(--green)]",
        destructive: "bg-[color-mix(in_srgb,var(--red)_12%,transparent)] text-[var(--red)]",
      },
    },
    defaultVariants: { variant: "secondary" },
  }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
