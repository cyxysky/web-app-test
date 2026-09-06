'use client';

import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { FloatingLayer } from '@/components/FloatingLayer';
import { HoverCard } from '@/components/HoverCard';
import { useI18n } from '@/i18n/I18nProvider';

export type CustomSelectOption = {
  description?: string;
  disabled?: boolean;
  group?: string;
  icon?: ReactNode;
  label: string;
  selectedLabel?: string;
  value: string;
};

const menuMaxHeight = 360;

export function CustomSelect({
  className,
  disabled = false,
  id,
  onChange,
  options,
  searchable = false,
  searchPlaceholder,
  title,
  tooltip,
  tooltipTitle,
  tooltipWidth,
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
  tooltip?: ReactNode;
  tooltipTitle?: ReactNode;
  tooltipWidth?: number;
  value: string;
}) {
  const { t } = useI18n();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const searchEnabled = searchable;
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

  useEffect(() => () => window.clearTimeout(closeTimerRef.current), []);

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
    <div className={className ? `custom-select ${className}` : 'custom-select'}>
      <HoverCard anchorRef={buttonRef} content={tooltip} disabled={open} title={tooltipTitle} width={tooltipWidth}>
        {(hoverProps) => (
          <button
            {...hoverProps}
            aria-controls={menuId}
            aria-expanded={open}
            aria-haspopup="listbox"
            className="custom-select-button"
            disabled={disabled}
            id={id}
            onClick={toggleMenu}
            onKeyDown={handleKeyDown}
            title={tooltip || tooltipTitle ? undefined : title}
            type="button"
          >
            <div className="custom-select-button-content">
              {selectedOption?.icon ? <span className="custom-select-icon">{selectedOption.icon}</span> : null}
              <span className="custom-select-button-label">{selectedOption?.selectedLabel || selectedOption?.label || value}</span>
            </div>
            <ChevronDown className={open ? 'open' : undefined} size={16} />
          </button>
        )}
      </HoverCard>
      <FloatingLayer
        active={open}
        align={className?.includes('browser-chat-provider-select') ? 'end' : 'start'}
        anchorRef={buttonRef}
        className={`custom-select-menu${className?.includes('browser-chat-provider-select') ? ' browser-chat-provider-select-menu' : ''} ${open ? 'open' : 'closing'}`}
        id={menuId}
        layerRef={menuRef}
        matchAnchorWidth={!className?.includes('browser-chat-provider-select')}
        maxHeight={menuMaxHeight}
        onDismiss={closeMenu}
        preferredWidth={className?.includes('browser-chat-provider-select') ? 336 : undefined}
        present={menuVisible}
        role="listbox"
      >
          {searchEnabled ? (
            <div className="custom-select-search">
              <Search aria-hidden="true" size={15} />
              <input
                aria-label={t('搜索选项')}
                autoComplete="off"
                onChange={(event) => setSearchQuery(event.currentTarget.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder={searchPlaceholder || t('搜索选项')}
                ref={searchRef}
                spellCheck={false}
                type="search"
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
                    className={`custom-select-option${index === activeIndex ? ' active' : ''}`}
                    disabled={option.disabled}
                    onClick={() => selectOption(option)}
                    onMouseEnter={() => setActiveIndex(index)}
                    role="option"
                    type="button"
                  >
                    <span className={`custom-select-option-content${option.icon ? ' has-icon' : ''}`}>
                      {option.icon ? <span className="custom-select-icon">{option.icon}</span> : null}
                      <span className="custom-select-option-copy">
                        <b>{option.label}</b>
                        {option.description ? <small>{option.description}</small> : null}
                      </span>
                    </span>
                    {option.value === value ? <Check size={15} /> : null}
                  </button>
                </Fragment>
              );
            })}
            {!filteredOptions.length ? <p className="custom-select-empty">{t('未找到匹配选项')}</p> : null}
          </div>
      </FloatingLayer>
    </div>
  );
}
