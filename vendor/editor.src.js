// vendor/editor.js の元ソース（CodeMirror 6 + Vim キーバインド）。
// 再ビルド: 空のフォルダで
//   npm i codemirror @codemirror/view @codemirror/state @codemirror/commands @replit/codemirror-vim esbuild
//   npx esbuild editor.src.js --bundle --minify --format=iife --outfile=editor.js
import { EditorView, keymap, drawSelection } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { vim, Vim } from '@replit/codemirror-vim';

window.MemueEditor = function (parent, { onChange, onSave }) {
  const vimC = new Compartment(), histC = new Compartment();
  let vimOn = false, silent = false;
  const theme = EditorView.theme({
    '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--bg)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.75', overflow: 'auto' },
    '.cm-content': { maxWidth: '800px', margin: '0 auto', padding: '18px 22px 40vh', caretColor: 'var(--text)' },
    '.cm-line': { padding: '0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--sel)' },
    '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)', borderTop: '1px solid var(--line)' },
    '.cm-vim-panel': { padding: '4px 12px', fontFamily: 'ui-monospace, Consolas, monospace' },
    '.cm-vim-panel input': { color: 'inherit', font: 'inherit' },
    '.cm-fat-cursor': { background: 'var(--accent)', color: 'var(--accent-text) !important' },
    '&:not(.cm-focused) .cm-fat-cursor': { background: 'none', outline: '1px solid var(--accent)', color: 'transparent !important' },
  });
  const extensions = () => [
    vimC.of(vimOn ? vim() : []),
    histC.of(history()), drawSelection(), EditorView.lineWrapping,
    keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
    theme,
    EditorView.updateListener.of((u) => { if (u.docChanged && !silent) onChange(); }),
  ];
  const view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions: extensions() }) });
  Vim.defineEx('write', 'w', () => onSave());
  return {
    get: () => view.state.doc.toString(),
    // 文書を丸ごと差し替える。state を作り直すと Vim 側の内部状態（ジャンプ履歴など）が壊れるため、置換＋履歴リセットで行う
    set(text) {
      silent = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 }, effects: histC.reconfigure([]) });
      view.dispatch({ effects: histC.reconfigure(history()) });
      silent = false; view.scrollDOM.scrollTop = 0;
    },
    cursor: () => view.state.selection.main.head,
    focus: () => view.focus(),
    setVim(on) { vimOn = !!on; view.dispatch({ effects: vimC.reconfigure(vimOn ? vim() : []) }); },
  };
};
