export const browserApiRuntimeSkillId = 'system-browser-api-runtime';

export const browserApiRuntimeSkillSummary = [
  '<system_skill>',
  `<id>${browserApiRuntimeSkillId}</id>`,
  '<title>Restricted Browser API Runtime</title>',
  '<description>Hidden built-in API reference for browserCode restricted mode. Only browserApi, nodeRepl, and console are exposed; read this Skill before the first browserCode call.</description>',
  '<required>true</required>',
  '</system_skill>',
].join('\n');

export const browserApiRuntimeSkillContent = `# Restricted Browser API Runtime

This is the authoritative API reference for browserCode when BROWSER_CODE_RUNTIME_MODE=restricted.

## Required sequence

1. Read this Skill in a separate model step:

~~~json
{ "action": "read", "skillId": "${browserApiRuntimeSkillId}", "reason": "读取受限浏览器 API 运行规范" }
~~~

2. Call readBrowserState({ reason }) for every new or resumed browser request and use its tabs, URL/title, snapshot, and surface evidence directly.
3. Run bounded browserCode cells using only browserApi, nodeRepl, and console. Playwright page/context/browser/tab/Locator, DOM evaluation, Node globals, files, environment variables, storage, cookies, attachmentVault, credentialVault, and raw credentials are absent.
4. Copy every locator field from exact current evidence. If a role, name, text, label, placeholder, test id, id, or CSS selector was not observed, perform a targeted read first.
5. Verify the requested business outcome and browserApi.surface() before claiming completion.
6. For navigation, prefer waitUntil:"domcontentloaded" and then wait for the exact URL or locator needed by the task. Do not wait for networkidle on pages with ads, analytics, chat, streaming, or background polling; those pages may never become network-idle even though the UI is ready.

browserCode runs ordinary top-level-await JavaScript in a persistent kernel. Prefer top-level var or fresh names. Return compact JSON-safe evidence with nodeRepl.write(value). All API results are primitives, arrays, or plain records, never Playwright/DOM objects. Let failed operations throw.

~~~ts
nodeRepl.write(value: unknown): void
console.log(...values: unknown[]): void
console.info(...values: unknown[]): void
console.warn(...values: unknown[]): void
console.error(...values: unknown[]): void
~~~

nodeRepl.write is the only result channel. Zero writes returns null, one write returns that value, and multiple writes return an array in write order. console methods are diagnostic logs and do not become the cell result. Restricted mode does not expose nodeRepl.emitImage; browserApi.screenshot emits the image and returns its metadata in one call.

## Shared types

~~~ts
type TabId = string;
type WaitUntil = "commit" | "domcontentloaded" | "load" | "networkidle";
type FrameSpec =
  | { selector: string }
  | { name: string; exact?: boolean }
  | { url: string; exact?: boolean };

type LocatorTarget = {
  tabId?: TabId;
  frame?: FrameSpec;
  within?: LocatorTarget;
  by: "role" | "text" | "label" | "placeholder" | "testId" |
      "altText" | "title" | "css" | "id";
  role?: string;
  name?: string;
  text?: string;
  selector?: string;
  id?: string;
  exact?: boolean;
  filter?: { hasText?: string; hasNotText?: string; visible?: boolean };
  index?: number | "first" | "last";
};

type TabInfo = {
  id: TabId; active: boolean; url: string; title: string;
  groupId?: string; groupTitle?: string; lastOpened: number;
};
~~~

within scopes a target under another observed locator. frame selects an iframe by observed selector, frame name, or frame URL. index is allowed only for an intentional observed positional choice; it belongs inside target (for example target:{by:"css",selector:"button",index:3}), never beside action. Normal visibility, uniqueness, and actionability validation still runs.

## Complete API

### Documentation, page state, and targeted reads

~~~ts
browserApi.documentation(): Promise<string>
browserApi.current(): Promise<TabInfo>
browserApi.snapshot(input?: { tabId?:TabId; scope?:"active"|"all" }): Promise<string>
browserApi.surface(input?: { tabId?:TabId }): Promise<{
  activeSurface?:object; surfaces:object[]; surfaceStack:object[]; topSurfaceIds:string[]
}>
browserApi.inspect(input?: {
  target?:LocatorTarget; tabId?:TabId; limit?:number; attributes?:string[]
}): Promise<{ count:number; items:Array<{
  index:number; tag:string; text:string; value?:string; role?:string;
  visible:boolean; enabled:boolean; editable:boolean; checked?:boolean;
  attributes:Record<string,string>;
  rect?:{x:number;y:number;width:number;height:number}
}> }>
browserApi.read(input: {
  target:LocatorTarget;
  operation:"count"|"text"|"texts"|"value"|"values"|"attribute"|
    "attributes"|"visible"|"enabled"|"editable"|"checked"|"rect"|"aria"|"html";
  attribute?:string; attributes?:string[]; limit?:number
}): Promise<unknown>
~~~

snapshot is the broad semantic read. inspect is a bounded structured read. read retrieves one exact property. rect requires exactly one rendered target and creates current rect evidence for pointer input.

### Tabs and navigation

~~~ts
browserApi.tabs.list(): Promise<TabInfo[]>
browserApi.tabs.current(): Promise<TabInfo>
browserApi.tabs.new(input?: {url?:string}): Promise<TabInfo>
browserApi.tabs.use(input:{tabId:TabId}): Promise<TabInfo>
browserApi.tabs.close(input?:{tabId?:TabId}): Promise<{closed:TabId;current?:TabInfo}>
browserApi.tabs.finalize(input?:{
  keep?:Array<{tabId:TabId;status:"deliverable"|"handoff"}>
}): Promise<TabInfo[]>
browserApi.navigate(input:
  | {action:"goto";url:string;tabId?:TabId;waitUntil?:WaitUntil;timeoutMs?:number}
  | {action:"reload"|"back"|"forward";tabId?:TabId;waitUntil?:WaitUntil;timeoutMs?:number}
): Promise<TabInfo>
~~~

Omit waitUntil only when the API default is acceptable. For modern business sites, use domcontentloaded plus browserApi.wait({kind:"locator",...}) for the first required control. networkidle is not a general-purpose "page ready" signal.

### Element actions, uploads, credentials, popup, and dialog handling

~~~ts
browserApi.act(input: {
  target:LocatorTarget;
  action:"click"|"dblclick"|"hover"|"tap"|"focus"|"blur"|"fill"|"clear"|
    "type"|"press"|"check"|"uncheck"|"selectOption"|"setInputValue"|"scrollIntoView"|
    "dragTo"|"upload"|"credentialFill";
  text?:string; key?:string; delay?:number;
  value?:string|string[]|{label?:string;value?:string;index?:number}|
    Array<{label?:string;value?:string;index?:number}>;
  target2?:LocatorTarget;
  attachmentId?:string;
  credentialRef?:string;
  button?:"left"|"middle"|"right";
  clickCount?:number;
  modifiers?:Array<"Alt"|"Control"|"ControlOrMeta"|"Meta"|"Shift">;
  position?:{x:number;y:number}; force?:boolean; timeoutMs?:number;
  expectNavigation?:{url?:string;waitUntil?:WaitUntil;timeoutMs?:number};
  expectPopup?:boolean;
  expectResponse?:{url:string;exact?:boolean;status?:number;method?:string;timeoutMs?:number};
  expectDownload?:boolean;
  dialog?:{action:"accept"|"dismiss";promptText?:string};
}): Promise<{
  action:string;tab:TabInfo;value?:unknown;popup?:TabInfo;dialog?:object;
  surface?:{activeSurface?:object;surfaceTransition:string;topSurfaceIds:string[]};
  response?:{url:string;status:number;method:string};
  download?:{url:string;suggestedFilename:string}
}>
~~~

upload accepts only a registered attachmentId and internally uses the trusted upload vault. credentialFill accepts only a credentialRef and never returns its secret. setInputValue sets a visible native input, textarea, or select and returns the value actually accepted by the browser. Use YYYY-MM-DD for date, HH:mm[:ss] for time, YYYY-MM-DDTHH:mm[:ss] for datetime-local, YYYY-MM for month, YYYY-Www for week, and #RRGGBB for color. Use check/uncheck for checkbox and radio. A hidden native control behind a custom picker remains non-actionable: operate the visible custom control instead. dialog, expectPopup, expectNavigation, expectResponse, and expectDownload install listeners before the action to avoid event races. Download metadata is observation only: a Playwright-side download never proves that a file reached the user; use the host file workflow for delivery.

### Keyboard, pointer, precise selection, and screenshots

~~~ts
browserApi.keyboard(input:
  | {action:"press";key:string;tabId?:TabId;delay?:number}
  | {action:"type"|"insertText";text:string;tabId?:TabId;delay?:number}
): Promise<{action:string;tab:TabInfo}>
browserApi.pointer(input:
  | {action:"click"|"dblclick";x:number;y:number;tabId?:TabId;button?:"left"|"middle"|"right";clickCount?:number}
  | {action:"move";x:number;y:number;tabId?:TabId;steps?:number}
  | {action:"down"|"up";tabId?:TabId;button?:"left"|"middle"|"right"}
  | {action:"wheel";tabId?:TabId;deltaX?:number;deltaY?:number}
): Promise<{action:string;tab:TabInfo}>
browserApi.setTextSelection(input:{
  target:LocatorTarget;
  selection:{
    exactText?:string;occurrence?:number;direction?:"forward"|"backward";
    start?:{afterText?:string;beforeText?:string;offset?:number;occurrence?:number};
    end?:{afterText?:string;beforeText?:string;offset?:number;occurrence?:number}
  }
}): Promise<object>
browserApi.screenshot(input?:{
  tabId?:TabId;target?:LocatorTarget;fullPage?:boolean;type?:"png"|"jpeg";quality?:number
}): Promise<{bytes:number;index:number;mimeType:string;tab:TabInfo}>
browserApi.viewport(input?:
  | {action?:"get";tabId?:TabId}
  | {action:"set";tabId?:TabId;width:number;height:number}
): Promise<{action:string;viewport:{width:number;height:number}|null;devicePixelRatio:number;scrollX:number;scrollY:number;visualScale:number;tab:TabInfo}>
~~~

A screenshot with target captures one exact element and is read-only. A vision model must emit a viewport screenshot without target/fullPage in one cell, end that cell, inspect the returned image, and click in later cells. One fresh viewport screenshot supports multiple coordinate clicks while document, URL, viewport, zoom, scroll, and five-minute validity remain unchanged. Full-page screenshots are read-only. A non-visual model must get one exact rect through read or inspect and click inside that rect; never guess x/y. viewport reads or explicitly sets page geometry; any geometry change invalidates prior screenshot/rect evidence.

### Waiting, verification, and form audit

~~~ts
browserApi.wait(input:
  | {kind:"timeout";ms:number;tabId?:TabId}
  | {kind:"loadState";state?:"domcontentloaded"|"load"|"networkidle";tabId?:TabId;timeoutMs?:number}
  | {kind:"url";url:string;exact?:boolean;tabId?:TabId;timeoutMs?:number;waitUntil?:WaitUntil}
  | {kind:"locator";target:LocatorTarget;state?:"attached"|"detached"|"visible"|"hidden";timeoutMs?:number}
  | {kind:"response";url:string;exact?:boolean;status?:number;method?:string;tabId?:TabId;timeoutMs?:number}
): Promise<object>
browserApi.verify(input:{
  description:string;tabId?:TabId;target?:LocatorTarget;
  state?:"visible"|"hidden"|"attached"|"detached"|"editable"|"enabled"|
    "checked"|"filled"|"value"|"text"|"attribute";
  attribute?:string;equals?:string;includes?:string;url?:string;
  activeSurface?:"opened"|"closed"|"changed"|"present"|"absent"
}): Promise<object>
browserApi.auditForm(input?:{tabId?:TabId;root?:LocatorTarget;limit?:number}): Promise<{
  controls:Array<object>;count:number;unresolved:number;truncated:boolean
}>
~~~

## Examples

Read the active popup/date picker, choose a date, confirm whether it stayed open, then close it explicitly:

~~~js
var popupSnapshot = await browserApi.snapshot({ scope:"active" });
nodeRepl.write(popupSnapshot);
~~~

~~~js
await browserApi.act({target:{by:"role",role:"button",name:"17",exact:true},action:"click"});
nodeRepl.write(await browserApi.surface());
~~~

~~~js
await browserApi.act({target:{by:"role",role:"button",name:"Done",exact:true},action:"click"});
nodeRepl.write(await browserApi.surface());
~~~

Fill, select, and upload after observing the exact targets:

~~~js
await browserApi.act({target:{by:"label",text:"Full name",exact:true},action:"fill",text:"Ada Lovelace"});
await browserApi.act({target:{by:"label",text:"Department",exact:true},action:"selectOption",value:{label:"Research"}});
await browserApi.act({target:{by:"label",text:"Departure date",exact:true},action:"setInputValue",value:"2026-09-05"});
await browserApi.act({target:{by:"label",text:"Pickup time",exact:true},action:"setInputValue",value:"16:08"});
await browserApi.act({target:{by:"css",selector:"input[type=file]"},action:"upload",attachmentId:"att_123"});
nodeRepl.write(await browserApi.inspect({target:{by:"css",selector:"form"},limit:20}));
~~~

Capture and switch to a popup without racing its event:

~~~js
var opened = await browserApi.act({
  target:{by:"role",role:"link",name:"Open report",exact:true},
  action:"click",expectPopup:true
});
nodeRepl.write(opened);
~~~

Non-visual coordinate action from exact rect evidence:

~~~js
var pickerRect = await browserApi.read({
  target:{by:"css",selector:"canvas[data-testid='color-picker']"},operation:"rect"
});
nodeRepl.write(pickerRect);
~~~

~~~js
await browserApi.pointer({
  action:"click",x:pickerRect.x+pickerRect.width/2,y:pickerRect.y+pickerRect.height/2
});
nodeRepl.write(await browserApi.snapshot({scope:"active"}));
~~~

## Prohibited boundaries

- Never reference page, context, browser, tab, agent, attachmentVault, credentialVault, or undocumented API members.
- browserApi rejects unknown input fields instead of silently ignoring them. Locator filter/index/within/frame belong inside target. Before an action uses a CSS target, resolve that exact current target with browserApi.read operation=count or browserApi.inspect; an action is never a selector probe.
- Treat every opened date/time/listbox/popover surface as a transaction. Use the surface returned by browserApi.act or browserApi.surface(), finish or close that current surface with an observed control, verify its transition, and only then target a background field.
- After a hidden/actionability failure, do not retry the same target with force, focus, or another action. Read the current surface and locate the visible custom trigger/options instead.
- Never use evaluate, DOM mutation, script click, dispatchEvent, storage/cookie access, raw network writes, local paths, imports, Node globals, or guessed selectors/coordinates.
- A successful action dispatch is not business success. Finish with a read-only verification and check for unexpected residual surfaces.
- After a failure, preserve the actual target/count/error, refresh only stale evidence, and rebuild the target. Never repeat unchanged failing input.
`;
