'use client';

import { useEffect, useRef, useState } from 'react';
import { basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { linter, lintGutter } from '@codemirror/lint';
import { tags } from '@lezer/highlight';
import { defaultChartTranslate, type ChartTranslate } from './i18n.js';

const jsonHighlight = HighlightStyle.define([
  { tag: tags.propertyName, color: '#6fc5f2' },
  { tag: tags.string, color: '#dba779' },
  { tag: tags.number, color: '#b4d39a' },
  { tag: tags.bool, color: '#c8a0df' },
  { tag: tags.null, color: '#e1948d' },
  { tag: tags.punctuation, color: '#d7dde4' },
]);
const checkJson = jsonParseLinter();

const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: '#181c1f', color: '#dde3e9', colorScheme: 'dark' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', lineHeight: '1.8', scrollbarColor: '#485059 #181c1f' },
  '.cm-content': { padding: '18px 0', minHeight: '100%', caretColor: '#e8edf2' },
  '.cm-line': { padding: '0 18px' },
  '.cm-gutters': { backgroundColor: '#181c1f', border: 'none', borderRight: '1px solid #2b3239', color: '#7f8994', fontSize: '12px' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '42px', padding: '0 10px 0 12px' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 5px' },
  '.cm-activeLine': { backgroundColor: '#ffffff06' },
  '.cm-activeLineGutter': { backgroundColor: '#222930', color: '#c2ccd6' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#e8edf2' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: '#334b65' },
  '.cm-selectionMatch': { backgroundColor: '#304250' },
  '.cm-matchingBracket': { backgroundColor: '#354554', outline: '1px solid #708196' },
  '.cm-tooltip': { border: '1px solid #3b4652', backgroundColor: '#242c34', color: '#dde3e9' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: '#354e69', color: '#fff' },
  '.cm-panels': { backgroundColor: '#242c34', color: '#dde3e9' },
  '.cm-searchMatch': { backgroundColor: '#6e5d32' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: '#8a7134' },
}, { dark: true });

/** Browser-local editor: no application imports, workers, remote assets or APIs. */
export function ChartJsonEditor({ value, disabled, onChange, translate: t = defaultChartTranslate }: {
  value: string; disabled: boolean; onChange(value: string): void;
  translate?: ChartTranslate;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const initialRef = useRef({ value, disabled });
  const applyingProp = useRef(false);
  const [readOnly] = useState(() => new Compartment());
  const [accessibility] = useState(() => new Compartment());
  onChangeRef.current = onChange;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const editor = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: initialRef.current.value,
        extensions: [
          basicSetup, json(), syntaxHighlighting(jsonHighlight), editorTheme,
          indentUnit.of('  '), keymap.of([indentWithTab]), lintGutter(),
          linter((view) => checkJson(view).map((diagnostic) => ({ ...diagnostic, to: Math.min(view.state.doc.length, diagnostic.from + 1) })), { delay: 250 }),
          accessibility.of([]),
          readOnly.of([EditorState.readOnly.of(initialRef.current.disabled), EditorView.editable.of(!initialRef.current.disabled)]),
          EditorView.updateListener.of((update) => { if (update.docChanged && !applyingProp.current) onChangeRef.current(update.state.doc.toString()); }),
        ],
      }),
    });
    editorRef.current = editor;
    return () => { editorRef.current = null; editor.destroy(); };
  }, [readOnly, accessibility]);

  useEffect(() => {
    editorRef.current?.dispatch({ effects: accessibility.reconfigure(
      EditorView.contentAttributes.of({ 'aria-label': t('完整图表配置 JSON'), 'aria-multiline': 'true', spellcheck: 'false' }),
    ) });
  }, [accessibility, t]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.state.doc.toString() === value) return;
    applyingProp.current = true;
    try { editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } }); }
    finally { applyingProp.current = false; }
  }, [value]);

  useEffect(() => {
    editorRef.current?.dispatch({ effects: readOnly.reconfigure([EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]) });
  }, [disabled, readOnly]);

  return <div className="capability-chart-json-editor" ref={containerRef} />;
}
