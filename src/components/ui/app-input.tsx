'use client';

import { InputGroup } from '@heroui/react/input-group';
import { forwardRef, type ComponentProps, type ReactNode } from 'react';

type AppInputProps = Omit<ComponentProps<typeof InputGroup.Input>, 'className' | 'prefix'> & {
  prefix?: ReactNode;
  suffix?: ReactNode;
};

export const AppInput = forwardRef<HTMLInputElement, AppInputProps>(function AppInput({
  prefix,
  suffix,
  ...props
}, ref) {
  return (
    <InputGroup fullWidth>
      {prefix ? <InputGroup.Prefix>{prefix}</InputGroup.Prefix> : null}
      <InputGroup.Input ref={ref} {...props} />
      {suffix ? <InputGroup.Suffix>{suffix}</InputGroup.Suffix> : null}
    </InputGroup>
  );
});
