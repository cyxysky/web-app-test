'use client';

import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export type CustomSelectOption = {
  description?: string;
  disabled?: boolean;
  group?: string;
  label: string;
  selectedLabel?: string;
  value: string;
};

export function CustomSelect({
  className,
  disabled = false,
  id,
  onChange,
  options,
  value,
}: {
  className?: string;
  disabled?: boolean;
  id?: string;
  onChange: (value: string) => void;
  options: CustomSelectOption[];
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const enabledOptions = useMemo(() => options.filter((option) => !option.disabled), [options]);
  const selectedOption = options.find((option) => option.value === value) || options[0];
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));

  useEffect(() => {
    function closeOnOutside(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    }

    document.addEventListener('mousedown', closeOnOutside);
    return () => {
      document.removeEventListener('mousedown', closeOnOutside);
      window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(selectedIndex);
    setMenuVisible(true);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (disabled) closeMenu();
  }, [disabled]);

  function openMenu() {
    if (disabled) return;
    window.clearTimeout(closeTimerRef.current);
    setMenuVisible(true);
    setOpen(true);
  }

  function closeMenu() {
    setOpen(false);
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => setMenuVisible(false), 170);
  }

  function toggleMenu() {
    if (open) closeMenu();
    else openMenu();
  }

  function moveActive(direction: 1 | -1) {
    if (!enabledOptions.length) return;
    const currentValue = options[activeIndex]?.value;
    const enabledIndex = Math.max(0, enabledOptions.findIndex((option) => option.value === currentValue));
    const nextOption = enabledOptions[(enabledIndex + direction + enabledOptions.length) % enabledOptions.length];
    setActiveIndex(options.findIndex((option) => option.value === nextOption.value));
  }

  function selectOption(option: CustomSelectOption) {
    if (option.disabled) return;
    onChange(option.value);
    closeMenu();
    buttonRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      const option = options[activeIndex];
      if (option) selectOption(option);
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
    }
  }

  return (
    <div className={className ? `custom-select ${className}` : 'custom-select'} ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="custom-select-button"
        disabled={disabled}
        id={id}
        onClick={toggleMenu}
        onKeyDown={handleKeyDown}
        ref={buttonRef}
        type="button"
      >
        <div>{selectedOption?.selectedLabel || selectedOption?.label || value}</div>
        <ChevronDown className={open ? 'open' : undefined} size={16} />
      </button>
      {menuVisible ? (
        <div
          className={open ? 'custom-select-menu open' : 'custom-select-menu closing'}
          onAnimationEnd={() => {
            if (!open) setMenuVisible(false);
          }}
          role="listbox"
          tabIndex={-1}
        >
          {options.map((option, index) => {
            const previous = options[index - 1];
            const showGroup = Boolean(option.group && option.group !== previous?.group);
            return (
              <Fragment key={option.value}>
                {showGroup ? <div className="custom-select-group">{option.group}</div> : null}
                <button
                  aria-selected={option.value === value}
                  className={`${index === activeIndex ? 'active' : ''}${option.group ? ' grouped' : ''}`.trim() || undefined}
                  disabled={option.disabled}
                  onClick={() => selectOption(option)}
                  onMouseEnter={() => setActiveIndex(index)}
                  role="option"
                  type="button"
                >
                  <span>
                    <b>{option.label}</b>
                    {option.description ? <small>{option.description}</small> : null}
                  </span>
                  {option.value === value ? <Check size={15} /> : null}
                </button>
              </Fragment>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
