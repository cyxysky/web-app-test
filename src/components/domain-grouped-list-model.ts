export type DomainListSort = 'updated-desc' | 'updated-asc' | 'name-asc' | 'name-desc';

export type DomainOption = {
  key: string;
  label: string;
};

export type DomainGroup<T> = DomainOption & {
  items: T[];
};

export const ALL_DOMAIN_FILTER = '__all_domains__';
const UNSCOPED_DOMAIN_KEY = '__unscoped_domain__';

function normalizedDomain(value: string) {
  return value.trim().toLowerCase();
}

function itemDomains(values: string[], unscopedLabel: string): DomainOption[] {
  const domains = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  if (!domains.length) return [{ key: UNSCOPED_DOMAIN_KEY, label: unscopedLabel }];
  return domains.map((label) => ({ key: `domain:${normalizedDomain(label)}`, label }));
}

function optionCompare(left: DomainOption, right: DomainOption) {
  if (left.key === UNSCOPED_DOMAIN_KEY) return -1;
  if (right.key === UNSCOPED_DOMAIN_KEY) return 1;
  return left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' });
}

export function domainOptionsForItems<T>(input: {
  items: T[];
  getDomains: (item: T) => string[];
  unscopedLabel: string;
}) {
  const byKey = new Map<string, DomainOption>();
  for (const item of input.items) {
    for (const domain of itemDomains(input.getDomains(item), input.unscopedLabel)) byKey.set(domain.key, domain);
  }
  return [...byKey.values()].sort(optionCompare);
}

export function buildDomainGroups<T>(input: {
  items: T[];
  query: string;
  selectedDomainKey: string;
  sort: DomainListSort;
  unscopedLabel: string;
  getDomains: (item: T) => string[];
  getId: (item: T) => string;
  getName: (item: T) => string;
  getSearchText: (item: T) => string[];
  getUpdatedAt: (item: T) => string;
}) {
  const query = input.query.trim().toLocaleLowerCase();
  const filteredItems = input.items.filter((item) => {
    const domains = itemDomains(input.getDomains(item), input.unscopedLabel);
    if (input.selectedDomainKey !== ALL_DOMAIN_FILTER
      && !domains.some((domain) => domain.key === input.selectedDomainKey)) return false;
    if (!query) return true;
    return input.getSearchText(item).join('\n').toLocaleLowerCase().includes(query);
  });
  const compare = (left: T, right: T) => {
    if (input.sort === 'name-asc' || input.sort === 'name-desc') {
      const value = input.getName(left).localeCompare(input.getName(right), undefined, { numeric: true, sensitivity: 'base' });
      if (value) return input.sort === 'name-asc' ? value : -value;
    } else {
      const value = input.getUpdatedAt(left).localeCompare(input.getUpdatedAt(right));
      if (value) return input.sort === 'updated-asc' ? value : -value;
    }
    return input.getId(left).localeCompare(input.getId(right));
  };
  const byDomain = new Map<string, DomainGroup<T>>();
  for (const item of filteredItems) {
    const domains = itemDomains(input.getDomains(item), input.unscopedLabel)
      .filter((domain) => input.selectedDomainKey === ALL_DOMAIN_FILTER || domain.key === input.selectedDomainKey);
    for (const domain of domains) {
      const group = byDomain.get(domain.key) || { ...domain, items: [] };
      group.items.push(item);
      byDomain.set(domain.key, group);
    }
  }
  return {
    filteredCount: filteredItems.length,
    groups: [...byDomain.values()]
      .sort(optionCompare)
      .map((group) => ({ ...group, items: [...group.items].sort(compare) })),
  };
}
