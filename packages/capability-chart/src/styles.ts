// Self-contained styles for the portable React entry point, including its modal.
export const chartStyles = `
.capability-chart-interactive.capability-chart-interactive{position:relative;display:block;min-width:0;margin:12px 0;padding:0;border:1px solid #e2e7ef;border-radius:14px;background:#fff;color:#253149;overflow:visible;font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 1px 3px #18243805}
.capability-chart-interactive:fullscreen{box-sizing:border-box;width:100%;height:100%;max-width:none;margin:0;padding:16px;display:flex;flex-direction:column;overflow:auto;background:#fff;border:0;border-radius:0}
:where(.capability-chart-interactive,.capability-chart-dialog) button,:where(.capability-chart-interactive) summary{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:7px;margin:0;border:0;border-radius:7px;background:transparent;color:#59677d;font:500 13px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:normal;text-transform:none;cursor:pointer;transition:background .15s,color .15s,box-shadow .15s}
:where(.capability-chart-interactive,.capability-chart-dialog) button:disabled{opacity:.4;cursor:default}
:where(.capability-chart-interactive,.capability-chart-dialog) :is(button,input,textarea,summary):focus-visible{outline:2px solid #5477ed;outline-offset:2px}
.capability-chart-icon{display:block;width:17px;height:17px;min-width:17px;flex:none;pointer-events:none}
.capability-chart-icon-slot{display:inline-flex;align-items:center;justify-content:center;flex:none;line-height:0;pointer-events:none}
.capability-chart-interactive .capability-chart-header{display:flex;align-items:center;gap:12px;flex-shrink:0;margin:0;padding:14px 16px 10px;color:#253149;font:500 14px/1.5 system-ui,sans-serif}
.capability-chart-title{flex:1;min-width:0;font-size:14px;font-weight:600;overflow-wrap:anywhere}
.capability-chart-actions{display:flex;align-items:center;gap:2px;padding:3px;border-radius:9px;background:#f5f7fa;flex:none}
.capability-chart-icon-button{width:30px;height:30px;flex:none;padding:6px}
.capability-chart-icon-button:hover:not(:disabled){background:#e8edf4;color:#273650}
.capability-chart-view-button{height:30px;padding:0 10px;white-space:nowrap;font-size:12px;letter-spacing:.01em}
.capability-chart-view-button:hover{background:#e8edf4;color:#273650}
.capability-chart-view-button[aria-pressed=true]{color:#3b57bf;background:#e8edfc}
.capability-chart-action-divider{width:1px;height:14px;background:#dfe5ee;margin:0 3px}
.capability-chart-viewport{position:relative;width:100%;min-height:240px;flex-shrink:0}
.capability-chart-interactive:fullscreen .capability-chart-viewport{height:auto!important;flex:1 0 340px;min-height:340px}
.capability-chart-render-surface{position:relative;width:100%;height:100%;overflow:hidden}
.capability-chart-render-surface>canvas{display:block;touch-action:none}
.capability-chart-download{position:relative;z-index:5}
.capability-chart-download summary{list-style:none}
.capability-chart-download summary::-webkit-details-marker{display:none}
.capability-chart-download[open]>summary{background:#e8edf4;color:#273650}
.capability-chart-download-menu{position:absolute;right:0;top:calc(100% + 9px);width:236px;max-width:calc(100vw - 40px);max-height:340px;overflow:auto;padding:6px;border:1px solid #e5e9f0;border-radius:12px;background:#fff;box-shadow:0 12px 36px #16223b1c,0 2px 8px #16223b08;text-align:left}
.capability-chart-download-menu>p{margin:0;padding:7px 10px 5px;font-size:11px;font-weight:500;letter-spacing:.02em;color:#97a0af}
.capability-chart-download-menu>p:not(:first-child){border-top:1px solid #edf0f5;margin-top:5px;padding-top:10px}
.capability-chart-download-menu button{display:flex;width:100%;justify-content:flex-start;padding:9px 10px;gap:10px;font-weight:400;color:#38465e}
.capability-chart-download-menu button:hover:not(:disabled){background:#f3f6fb}
.capability-chart-download-menu button>span:not(.capability-chart-icon-slot){flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.capability-chart-download-menu small{font-size:10px;font-weight:500;color:#8b97aa}
.capability-chart-hint,.capability-chart-message{padding:8px 16px;margin:0;color:#8590a2;font-size:12px;font-weight:400}
.capability-chart-interactive [role=alert]{color:#b42318;overflow-wrap:anywhere}
.capability-chart-dialog{box-sizing:border-box;width:min(920px,calc(100vw - 48px));height:min(640px,calc(100dvh - 64px));max-width:none;max-height:calc(100dvh - 64px);margin:auto;padding:0;overflow:hidden;border:1px solid #e4e8ef;border-radius:18px;background:#fff;color:#29364c;font:400 13px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 28px 90px #0a163b33,0 4px 16px #0a163b10}
.capability-chart-dialog[open]{display:flex;flex-direction:column;animation:capability-chart-dialog-in .16s ease-out}
.capability-chart-dialog{outline:none;color-scheme:light}
.capability-chart-dialog::backdrop{background:#14203955;backdrop-filter:blur(4px)}
.capability-chart-dialog *{box-sizing:border-box}
.capability-chart-dialog.capability-chart-dialog p{margin:0;padding:0;font-size:12px;font-weight:400;color:#8a95a6;line-height:1.5}
.capability-chart-dialog-header{display:flex;align-items:center;gap:12px;padding:24px 24px 20px;flex-shrink:0}
.capability-chart-dialog-header>div{flex:1;min-width:0}
.capability-chart-dialog-header h2{margin:0 0 4px;padding:0;color:#202c42;font-size:18px;line-height:1.35;font-weight:600;letter-spacing:-.02em}
.capability-chart-dialog-header p{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.capability-chart-dialog-emblem{display:flex;align-items:center;justify-content:center;width:42px;height:42px;flex:none;background:#f0f4ff;color:#5370c8;border:1px solid #e4eafd;border-radius:12px}
.capability-chart-dialog-emblem .capability-chart-icon{width:21px;height:21px}
.capability-chart-dialog-header>.capability-chart-icon-button{align-self:flex-start;margin:-5px -6px 0 0;color:#8b96a6}
.capability-chart-editor-modebar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 24px 18px;border-bottom:1px solid #edf0f5;flex-shrink:0}
.capability-chart-segments{display:flex;gap:3px;padding:3px;border-radius:9px;background:#f1f3f7}
.capability-chart-segments button{min-width:110px;height:34px;padding:0 11px;border:1px solid transparent;border-radius:6px;font-size:12px;color:#778398}
.capability-chart-segments button[aria-pressed=false]:hover:not(:disabled){background:#e7ebf3;color:#50617e}
.capability-chart-segments button[aria-pressed=true]{background:#e3eaff;border-color:#bdcbf8;box-shadow:0 1px 2px #263d7410;color:#244ab6;font-weight:600}
.capability-chart-segments button .capability-chart-icon{width:15px;height:15px;min-width:15px}
.capability-chart-edit-status{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:11px;color:#94a0b1}
.capability-chart-edit-status.is-dirty{color:#9b8055}
.capability-chart-edit-status.is-dirty:before{content:'';width:5px;height:5px;border-radius:50%;background:#d8a354}
.capability-chart-editor-body{display:flex;flex:1;min-height:0;overflow:hidden}
.capability-chart-data-nav{width:196px;flex:none;overflow:auto;padding:18px 10px;background:#fafbfe;border-right:1px solid #edf0f5}
.capability-chart-data-nav>p{display:flex;align-items:center;gap:6px;margin:0 10px 12px!important;letter-spacing:.02em}
.capability-chart-data-nav>p>span{font-size:10px;padding:0 5px;background:#e9edf4;color:#7f8ba0;border-radius:4px}
.capability-chart-data-nav>button{display:flex;justify-content:flex-start;text-align:left;gap:10px;width:100%;padding:11px 10px;margin:0 0 4px;border-radius:8px;color:#8a96aa}
.capability-chart-data-nav>button:hover{background:#eff3f9}
.capability-chart-data-nav>button[aria-current=true]{background:#eaf0ff;color:#5976d4}
.capability-chart-data-nav>button>span:not(.capability-chart-icon-slot){min-width:0;flex:1}
.capability-chart-data-nav strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:500;line-height:1.6;color:#546179}
.capability-chart-data-nav [aria-current=true] strong{color:#3658bd}
.capability-chart-data-nav small{display:block;font-size:10px;line-height:1.8;font-weight:400;color:#98a3b4}
.capability-chart-data-main{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;padding:20px 24px 12px}
.capability-chart-table-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;flex-shrink:0}
.capability-chart-table-heading h3{margin:0 0 3px;color:#384760;font-size:14px;font-weight:600;line-height:1.5}
.capability-chart-secondary-button{height:34px;padding:0 13px;border:1px solid #dfe5ee;background:#fff;color:#5a6780;font-size:12px;white-space:nowrap}
.capability-chart-secondary-button:hover:not(:disabled){background:#f5f7fc;border-color:#cbd5e5}
.capability-chart-secondary-button .capability-chart-icon{width:14px;height:14px;min-width:14px}
.capability-chart-table-scroll{min-height:0;overflow:auto;border:1px solid #e6ebf2;border-radius:9px;background:#fff}
.capability-chart-table-scroll table{width:100%;margin:0;border:0;border-collapse:separate;border-spacing:0;table-layout:auto;font-size:13px;font-weight:400;color:#536078}
.capability-chart-table-scroll thead{position:sticky;top:0;z-index:1}
.capability-chart-table-scroll thead th{height:37px;padding:0 14px;border:0;border-bottom:1px solid #e6ebf2;background:#f8fafd;text-align:left;color:#8793a6;font-size:11px;font-weight:500;white-space:nowrap}
.capability-chart-table-scroll tbody td,.capability-chart-table-scroll tbody th{height:45px;padding:0;border:0;border-bottom:1px solid #edf1f6;vertical-align:middle;font-weight:400}
.capability-chart-table-scroll tbody tr:last-child>:is(td,th){border-bottom:0}
.capability-chart-table-scroll tbody tr:hover{background:#fbfcff}
.capability-chart-table-scroll .capability-chart-row-number{width:46px;min-width:46px;padding:0 14px;text-align:center;color:#a5afbe;font-size:11px;font-variant-numeric:tabular-nums}
.capability-chart-table-scroll .capability-chart-row-label{width:110px;min-width:80px;padding:0 14px;color:#8390a3;font-size:12px}
.capability-chart-table-scroll .capability-chart-row-actions{width:44px;min-width:44px;padding:0 7px}
.capability-chart-table-scroll input{display:block;box-sizing:border-box;width:100%;min-width:100px;height:44px;padding:0 14px;border:0;border-radius:0;background:transparent;color:#344460;font:400 13px/1.5 system-ui,sans-serif;font-variant-numeric:tabular-nums;box-shadow:none;transition:background .12s}
.capability-chart-table-scroll input:hover{background:#f5f8ff}
.capability-chart-table-scroll input:focus{outline:2px solid #7591eb;outline-offset:-2px;background:#f5f8ff}
.capability-chart-delete-row{color:#a6b0c0;opacity:0}
.capability-chart-table-scroll tr:hover .capability-chart-delete-row,.capability-chart-delete-row:focus-visible{opacity:1}
.capability-chart-delete-row:hover:not(:disabled){background:#fff0ef;color:#c46b64}
.capability-chart-delete-row .capability-chart-icon{width:15px;height:15px;min-width:15px}
.capability-chart-table-bottom{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:40px;font-size:11px;color:#99a4b5;flex-shrink:0}
.capability-chart-table-bottom>div{display:flex;align-items:center;gap:4px;font-variant-numeric:tabular-nums}
.capability-chart-editor-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 24px;border-top:1px solid #e9edf4;background:#fff;flex:0 0 auto;position:relative;z-index:1}
.capability-chart-editor-footer>span{color:#99a4b5;font-size:11px}
.capability-chart-editor-footer>div{display:flex;align-items:center;gap:8px;margin-left:auto}
.capability-chart-editor-footer button{height:36px;min-width:76px;padding:0 17px;font-size:12px}
.capability-chart-dialog .capability-chart-primary-button{display:inline-flex;flex:none;min-width:94px;background:#385ac7;border:1px solid #385ac7;color:#fff;font-weight:600;box-shadow:0 1px 2px #2140981f;opacity:1}
.capability-chart-dialog .capability-chart-primary-button:hover:not(:disabled){background:#2b4db9;border-color:#2b4db9}
.capability-chart-dialog .capability-chart-primary-button:disabled{background:#9caddc;border-color:#9caddc;color:#fff;opacity:1}
.capability-chart-editor-error{padding:10px 14px;margin:8px 24px 12px;border:1px solid #f1d6d2;border-radius:8px;background:#fff8f7;flex-shrink:0}
.capability-chart-dialog .capability-chart-editor-error p{color:#b6675e;font-size:12px;max-height:70px;overflow:auto;overflow-wrap:anywhere}
.capability-chart-editor-error button{justify-content:flex-start;margin-top:5px;padding:4px 0;color:#a75f57;font-size:12px}
.capability-chart-editor-body.is-json{padding:20px 24px}
.capability-chart-code-panel{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;overflow:hidden;border:1px solid #30373e;border-radius:10px;background:#181c1f}
.capability-chart-code-header{display:flex;flex:0 0 auto;align-items:center;justify-content:space-between;gap:12px;padding:9px 14px;border-bottom:1px solid #30373e;background:#20262b;color:#bdc6cf;font-size:12px}
.capability-chart-code-header small{margin-left:8px;font:500 10px/1.5 ui-monospace,monospace;color:#9aa7ba}
.capability-chart-code-header button{font-size:11px;padding:4px 8px;color:#c0cbd8}
.capability-chart-code-header button:hover:not(:disabled){background:#333d47;color:#fff}
.capability-chart-json-editor{flex:1;min-height:0;width:100%;overflow:hidden}
.capability-chart-json-editor .cm-editor{height:100%}
.capability-chart-json-editor .cm-scroller::-webkit-scrollbar-thumb{background-color:#485059!important}
.capability-chart-json-editor .cm-scroller::-webkit-scrollbar-thumb:hover{background-color:#65717e!important}
.capability-chart-code-loading{display:flex;align-items:center;justify-content:center;flex:1;color:#9eabb9;font-size:12px}
.capability-chart-editor-empty{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#97a6bb}
.capability-chart-sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.capability-chart-loading{position:absolute;top:45%;left:35%;color:#94a0b2;font-size:12px}
.capability-chart-tooltip{position:absolute;pointer-events:none;background:#122033e8;color:white;padding:6px 9px;border-radius:6px;max-width:280px;z-index:2;font-size:12px}
.capability-chart-legend{position:absolute;left:10px;right:10px;top:6px;display:flex;flex-wrap:wrap;justify-content:center;gap:5px 14px;pointer-events:none;font-size:12px}
.capability-chart-legend span{background:#ffffffe6;padding:2px 6px;border-radius:4px;color:#24334b}
.capability-chart-legend span:before{content:'';display:inline-block;width:9px;height:9px;border-radius:2px;background:var(--series-color);margin-right:5px}
@keyframes capability-chart-dialog-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:640px){
  .capability-chart-dialog{width:calc(100vw - 24px);height:calc(100dvh - 32px);max-height:calc(100dvh - 32px);border-radius:14px}
  .capability-chart-dialog-header{padding:18px 16px 16px;gap:10px}
  .capability-chart-dialog-header h2{font-size:16px}
  .capability-chart-dialog-emblem{width:36px;height:36px;border-radius:10px}
  .capability-chart-editor-modebar{padding:0 16px 14px;gap:6px}
  .capability-chart-segments button{min-width:94px;padding:0 7px;font-size:11px;gap:5px}
  .capability-chart-edit-status{font-size:10px}
  .capability-chart-editor-body{flex-direction:column}
  .capability-chart-data-nav{display:flex;width:100%;padding:10px 12px;border-right:0;border-bottom:1px solid #edf0f5;overflow-x:auto;gap:5px}
  .capability-chart-data-nav>p{display:none}
  .capability-chart-data-nav>button{width:auto;min-width:125px;max-width:200px;flex:none;margin:0;padding:8px 10px}
  .capability-chart-data-main{padding:16px 16px 8px}
  .capability-chart-table-heading{margin-bottom:12px}
  .capability-chart-table-heading h3{font-size:13px}
  .capability-chart-table-heading p{font-size:11px}
  .capability-chart-secondary-button{padding:0 10px}
  .capability-chart-table-scroll .capability-chart-row-number{width:32px;min-width:32px;padding:0 8px}
  .capability-chart-table-scroll .capability-chart-row-label{width:70px;min-width:60px;padding:0 8px}
  .capability-chart-delete-row{opacity:1}
  .capability-chart-editor-footer{padding:14px 16px}
  .capability-chart-editor-footer>span{display:none}
  .capability-chart-editor-error{margin:8px 16px}
  .capability-chart-editor-body.is-json{padding:16px}
  .capability-chart-json-editor .cm-editor{font-size:12px}
}
@media(max-width:420px){.capability-chart-interactive .capability-chart-header{padding:12px 12px 8px;gap:8px}.capability-chart-title{font-size:13px}.capability-chart-view-button{padding:0 7px;font-size:11px}.capability-chart-actions .capability-chart-icon-button{width:28px;height:28px;padding:5px}}
@media(prefers-reduced-motion:reduce){.capability-chart-dialog[open]{animation:none}:where(.capability-chart-interactive,.capability-chart-dialog) button{transition:none}}
`;
