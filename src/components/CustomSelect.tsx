'use client';

import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useI18n } from '@/i18n/I18nProvider';

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
  searchable,
  searchPlaceholder,
  title,
  value,
}: {
  className?: string;
  disabled?: boolean;
  id?: string;
  onChange: (value: string) => void;
  options: CustomSelectOption[];
  searchable?: boolean;
  searchPlaceholder?: string;
  title?: string;
  value: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const searchEnabled = searchable ?? options.length > 8;
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const filteredOptions = useMemo(() => options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => {
      if (!normalizedQuery) return true;
      return [option.label, option.selectedLabel, option.description, option.group, option.value]
        .filter(Boolean)
        .join('\n')
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    }), [normalizedQuery, options]);
  const enabledOptions = useMemo(() => filteredOptions.filter(({ option }) => !option.disabled), [filteredOptions]);
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
    setSearchQuery('');
    setActiveIndex(selectedIndex);
    setMenuVisible(true);
    if (searchEnabled) requestAnimationFrame(() => searchRef.current?.focus());
  }, [open, searchEnabled, selectedIndex]);

  useEffect(() => {
    if (!open || !enabledOptions.length) return;
    if (enabledOptions.some(({ index }) => index === activeIndex)) return;
    const selected = enabledOptions.find(({ index }) => index === selectedIndex);
    setActiveIndex((selected || enabledOptions[0]).index);
  }, [activeIndex, enabledOptions, open, selectedIndex]);

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
    const enabledIndex = enabledOptions.findIndex(({ index }) => index === activeIndex);
    const nextIndex = enabledIndex < 0
      ? (direction === 1 ? 0 : enabledOptions.length - 1)
      : (enabledIndex + direction + enabledOptions.length) % enabledOptions.length;
    setActiveIndex(enabledOptions[nextIndex].index);
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
      const option = filteredOptions.find((item) => item.index === activeIndex)?.option;
      if (option) selectOption(option);
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
    }
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const option = filteredOptions.find((item) => item.index === activeIndex)?.option;
      if (option) selectOption(option);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (searchQuery) setSearchQuery('');
      else {
        closeMenu();
        buttonRef.current?.focus();
      }
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
        title={title}
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
          {searchEnabled ? (
            <div className="custom-select-search">
              <Search aria-hidden="true" size={15} />
              <input
                aria-label={t('搜索选项')}
                onChange={(event) => setSearchQuery(event.currentTarget.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder={searchPlaceholder || t('搜索选项')}
                ref={searchRef}
                value={searchQuery}
              />
            </div>
          ) : null}
          <div className="custom-select-options">
            {filteredOptions.map(({ option, index }, filteredIndex) => {
              const previous = filteredOptions[filteredIndex - 1]?.option;
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
            {!filteredOptions.length ? <p className="custom-select-empty">{t('未找到匹配选项')}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
