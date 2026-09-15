/** `deliverables` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'deliverables'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'produced.label': '产物',
  'produced.moreOne': '+ 1 个文件',
  'produced.more': '+ {count} 个文件',
  'produced.open': '打开 {name}',
  'produced.showInFolder': '在文件夹中显示',
  'view.tab': '成果',
  'view.title': '成果',
  'view.count': '{count} 个文件',
  'view.empty': '此会话尚未生成文件',
  'view.turn': '第 {turn} 轮',
  'view.loadOlder': '加载更早成果',
  'view.loadingOlder': '正在加载',
}

/** English dictionary (same key set). */
export const en: Record<DeliverablesKey, string> = {
  'produced.label': 'Produced',
  'produced.moreOne': '+ 1 file',
  'produced.more': '+ {count} files',
  'produced.open': 'Open {name}',
  'produced.showInFolder': 'Show in folder',
  'view.tab': 'Files',
  'view.title': 'Deliverables',
  'view.count': '{count} files',
  'view.empty': 'No files have been produced in this session',
  'view.turn': 'Turn {turn}',
  'view.loadOlder': 'Load earlier files',
  'view.loadingOlder': 'Loading',
}

/** Union of this namespace's dictionary keys. */
export type DeliverablesKey = keyof typeof zh
