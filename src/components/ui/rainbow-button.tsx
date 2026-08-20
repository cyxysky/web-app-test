import React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const rainbowButtonVariants = cva(
  'magic-rainbow-button relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap outline-none transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'magic-rainbow-button--default',
        outline: 'magic-rainbow-button--outline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 px-3 text-xs',
        lg: 'h-11 px-8',
        icon: 'size-10 p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface RainbowButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof rainbowButtonVariants> {
  asChild?: boolean;
}

export const RainbowButton = React.forwardRef<HTMLButtonElement, RainbowButtonProps>(
  ({ asChild = false, className, size, variant, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(rainbowButtonVariants({ className, size, variant }))}
        data-slot="rainbow-button"
        ref={ref}
        {...props}
      />
    );
  },
);

RainbowButton.displayName = 'RainbowButton';

export { rainbowButtonVariants };
