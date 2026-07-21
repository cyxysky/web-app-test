'use client';

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
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

type MenuLayout = {
  maxHeight: number;
  placement: 'up' | 'down';
};

const menuGap = 6;
const menuMaxHeight = 360;
const viewportMargin = 8;

function clipsVerticalOverflow(element: HTMLElement) {
  const overflowY = window.getComputedStyle(element).overflowY;
  return overflowY === 'auto' || overflowY === 'clip' || overflowY === 'hidden' || overflowY === 'scroll';
}

function getMenuVerticalBounds(root: HTMLElement) {
  let top = viewportMargin;
  let bottom = document.documentElement.clientHeight - viewportMargin;
  let ancestor = root.parentElement;

  // An absolutely-positioned popup is clipped by every scrolling ancestor, not
  // only by the browser viewport. This matters in modal bodies with fixed
  // headers/footers: viewport-only placement can put a menu behind the footer.
  while (ancestor && ancestor !== document.body) {
    if (clipsVerticalOverflow(ancestor)) {
      const rect = ancestor.getBoundingClientRect();
      top = Math.max(top, rect.top);
      bottom = Math.min(bottom, rect.bottom);
    }
    ancestor = ancestor.parentElement;
  }

  return { bottom, top };
}

export function CustomSelect({
  className,
  disabled = false,
  id,
  onChange,
  options,
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
  const [menuLayout, setMenuLayout] = useState<MenuLayout | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const searchEnabled = true;
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

  useLayoutEffect(() => {
    if (!open || !menuVisible) return undefined;

    function updateMenuLayout() {
      const button = buttonRef.current;
      const menu = menuRef.current;
      if (!button || !menu) return;

      const buttonRect = button.getBoundingClientRect();
      const bounds = getMenuVerticalBounds(rootRef.current || button);
      const spaceAbove = Math.max(0, buttonRect.top - menuGap - bounds.top);
      const spaceBelow = Math.max(0, bounds.bottom - buttonRect.bottom - menuGap);
      const desiredHeight = menu.getBoundingClientRect().height;
      const placement = desiredHeight <= spaceBelow
        ? 'down'
        : desiredHeight <= spaceAbove
          ? 'up'
          : spaceAbove > spaceBelow
            ? 'up'
            : 'down';
      const maxHeight = Math.min(
        menuMaxHeight,
        Math.floor(placement === 'up' ? spaceAbove : spaceBelow),
      );

      setMenuLayout((current) => current?.placement === placement && current.maxHeight === maxHeight
        ? current
        : { maxHeight, placement });
    }

    updateMenuLayout();
    window.addEventListener('resize', updateMenuLayout);
    window.addEventListener('scroll', updateMenuLayout, true);
    return () => {
      window.removeEventListener('resize', updateMenuLayout);
      window.removeEventListener('scroll', updateMenuLayout, true);
    };
  }, [menuVisible, open]);

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
    setMenuLayout(null);
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
          className={`custom-select-menu custom-select-menu--${menuLayout?.placement || 'down'} ${open ? 'open' : 'closing'}`}
          onAnimationEnd={() => {
            if (!open) setMenuVisible(false);
          }}
          ref={menuRef}
          role="listbox"
          style={{ '--custom-select-menu-max-height': `${Math.max(0, menuLayout?.maxHeight ?? menuMaxHeight)}px` } as CSSProperties}
          tabIndex={-1}
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
