'use client';

import { Editor } from '@tinymce/tinymce-react';
import { useI18n } from '@/i18n/I18nProvider';
import { useTheme } from '@/theme/ThemeProvider';

type RichTextEditorProps = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  minHeight?: number;
};

export function RichTextEditor({
  id,
  value,
  onChange,
  disabled,
  placeholder,
  minHeight = 220,
}: RichTextEditorProps) {
  const { language, t } = useI18n();
  const { mode } = useTheme();
  const isDarkMode = mode === 'dark';
  const contentStyle = isDarkMode
    ? 'body{background:#11141a;font-family:Inter,Arial,"Microsoft YaHei",sans-serif;font-size:14px;line-height:1.65;color:#f5f5f6;} p{margin:0 0 8px;} ul,ol{margin-top:0;margin-bottom:8px;padding-left:22px;} a{color:#34d399;} blockquote{border-left:3px solid #3b4352;color:#d1d5db;margin:0 0 8px;padding-left:10px;}'
    : 'body{font-family:Inter,Arial,"Microsoft YaHei",sans-serif;font-size:14px;line-height:1.65;color:#171717;} p{margin:0 0 8px;} ul,ol{margin-top:0;margin-bottom:8px;padding-left:22px;}';
  return (
    <div className="rich-text-editor">
      <Editor
        disabled={disabled}
        id={id}
        key={`${id}-${language}-${mode}`}
        init={{
          base_url: '/api/tinymce',
          suffix: '.min',
          height: minHeight,
          min_height: minHeight,
          menubar: false,
          branding: false,
          promotion: false,
          resize: true,
          statusbar: false,
          plugins: 'autoresize lists link table code',
          toolbar: 'undo redo | blocks | bold italic underline | bullist numlist | link table | removeformat code',
          skin: isDarkMode ? 'oxide-dark' : 'oxide',
          content_css: isDarkMode ? 'dark' : 'default',
          block_formats: t('段落=p;标题 2=h2;标题 3=h3;引用=blockquote'),
          placeholder,
          content_style: contentStyle,
        }}
        licenseKey="gpl"
        onEditorChange={onChange}
        tinymceScriptSrc="/api/tinymce/tinymce.min.js"
        value={value}
      />
    </div>
  );
}
