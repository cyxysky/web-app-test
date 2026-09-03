'use client';

import { ColorArea } from '@heroui/react/color-area';
import { ColorPicker } from '@heroui/react/color-picker';
import { ColorSlider } from '@heroui/react/color-slider';
import { ColorSwatch } from '@heroui/react/color-swatch';

export function ColorPickerField({
  ariaLabel,
  onChange,
  value,
}: {
  ariaLabel: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <ColorPicker onChange={(color) => onChange(color.toString('hex'))} value={value}>
      <ColorPicker.Trigger aria-label={ariaLabel}>
        <ColorSwatch size="sm" />
        <span>{value.toUpperCase()}</span>
      </ColorPicker.Trigger>
      <ColorPicker.Popover offset={6} placement="bottom end">
        <ColorArea colorSpace="hsb" xChannel="saturation" yChannel="brightness">
          <ColorArea.Thumb />
        </ColorArea>
        <ColorSlider channel="hue" colorSpace="hsb">
          <ColorSlider.Track>
            <ColorSlider.Thumb />
          </ColorSlider.Track>
        </ColorSlider>
      </ColorPicker.Popover>
    </ColorPicker>
  );
}
