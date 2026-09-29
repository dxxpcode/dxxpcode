import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] font-medium transition-colors duration-150 outline-none cursor-pointer disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 focus-visible:shadow-[0_0_0_3px_var(--ring)]",
  {
    variants: {
      variant: {
        default: "bg-[var(--text)] text-[var(--bg)] hover:opacity-85",
        secondary: "bg-[var(--surface2)] text-[var(--text)] hover:bg-[var(--ring)]",
        ghost: "text-[var(--dim)] hover:bg-[var(--surface2)] hover:text-[var(--text)]",
        outline: "border border-[var(--border)] text-[var(--text)] hover:bg-[var(--surface2)]",
      },
      size: {
        default: "h-7 px-2.5 text-[12.5px]",
        sm: "h-6 px-2 text-[12px]",
        icon: "h-6 w-6",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
