import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL_DOMAIN_FILTER, buildDomainGroups, domainOptionsForItems } from './domain-grouped-list-model';

type Item = { id: string; name: string; domains: string[]; updatedAt: string; text: string };

const items: Item[] = [
  { id: '1', name: 'Beta', domains: ['b.example', 'a.example'], updatedAt: '2026-01-02', text: 'second' },
  { id: '2', name: 'Alpha', domains: ['a.example'], updatedAt: '2026-01-03', text: 'first' },
  { id: '3', name: 'Global', domains: [], updatedAt: '2026-01-01', text: 'shared' },
];

const accessors = {
  getDomains: (item: Item) => item.domains,
  getId: (item: Item) => item.id,
  getName: (item: Item) => item.name,
  getSearchText: (item: Item) => [item.name, item.text, ...item.domains],
  getUpdatedAt: (item: Item) => item.updatedAt,
};

test('domain options keep the unscoped group first and de-duplicate domains', () => {
  assert.deepEqual(domainOptionsForItems({ items, getDomains: accessors.getDomains, unscopedLabel: '所有域名' }), [
    { key: '__unscoped_domain__', label: '所有域名' },
    { key: 'domain:a.example', label: 'a.example' },
    { key: 'domain:b.example', label: 'b.example' },
  ]);
});

test('multi-domain items appear in each matching accordion group and sort within groups', () => {
  const result = buildDomainGroups({
    items,
    query: '',
    selectedDomainKey: ALL_DOMAIN_FILTER,
    sort: 'name-asc',
    unscopedLabel: '所有域名',
    ...accessors,
  });
  assert.equal(result.filteredCount, 3);
  assert.deepEqual(result.groups.map((group) => [group.label, group.items.map((item) => item.id)]), [
    ['所有域名', ['3']],
    ['a.example', ['2', '1']],
    ['b.example', ['1']],
  ]);
});

test('query and domain filters combine before grouping', () => {
  const result = buildDomainGroups({
    items,
    query: 'second',
    selectedDomainKey: 'domain:a.example',
    sort: 'updated-desc',
    unscopedLabel: '所有域名',
    ...accessors,
  });
  assert.equal(result.filteredCount, 1);
  assert.deepEqual(result.groups.map((group) => [group.label, group.items.map((item) => item.id)]), [
    ['a.example', ['1']],
  ]);
});
