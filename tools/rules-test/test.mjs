// ============================================================
// firestore.rules の結合テスト（Firestore Emulator + rules-unit-testing）
// 実行：tools/rules-test 内で
//   npx firebase-tools emulators:exec --only firestore --project demo-rules-test "node test.mjs"
// ※ Firestore エミュレータには Java が必要。
// 結果：ケースごとの「期待 / 結果」表をコンソールに出力し、
//       期待どおりでないものが1つでもあれば終了コード1で終わる。
// ============================================================
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, setDoc, addDoc, collection, getDocs, getDoc, updateDoc,
  deleteDoc, writeBatch, serverTimestamp, arrayUnion, increment, deleteField,
} from 'firebase/firestore';

const here = path.dirname(fileURLToPath(import.meta.url));
const rules = readFileSync(path.join(here, '../../firestore.rules'), 'utf8');

const U1 = 'uid-test-1';
const U2 = 'uid-test-2';

// ルール読み込み済みのテスト環境（エミュレータ 127.0.0.1:8080 前提）
const testEnv = await initializeTestEnvironment({
  projectId: 'demo-rules-test',
  firestore: { rules, host: '127.0.0.1', port: 8080 },
});

// コンテキスト取得（firestore() は Firestore 用。database() は Realtime DB 用なので使わない）
const dbOf = (ctx) => (ctx.firestore ? ctx.firestore() : ctx.database());
const anon = dbOf(testEnv.unauthenticatedContext());
const u1 = dbOf(testEnv.authenticatedContext(U1));
const u2 = dbOf(testEnv.authenticatedContext(U2));

// ---------------- 結果表の収集 ----------------
const rows = [];
let bad = 0;
async function check(label, shouldPass, promise) {
  let ok = false;
  let detail = '';
  try {
    if (shouldPass) { await assertSucceeds(promise); ok = true; }
    else { await assertFails(promise); ok = true; }
  } catch (e) {
    ok = false;
    detail = String(e && e.message ? e.message : e).slice(0, 80);
  }
  rows.push({ ケース: label, 期待: shouldPass ? '許可' : '拒否', 結果: ok ? '合格' : '不合格', 備考: detail });
  if (!ok) bad++;
}

// ---------------- フィクスチャ投入（ルール無効コンテキスト） ----------------
const HISTORY = [{ idx: 40, color: 'black' }, { idx: 30, color: 'white' }];
async function seed(id, opts = {}) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = dbOf(ctx);
    await setDoc(doc(db, 'posts', id), {
      text: 'seed ' + id,
      category: '検討',
      history: HISTORY,
      // 旧形式（数値）を基本とし、opts.tsServer で新形式（Timestamp）も作れる
      createdAt: opts.tsServer ? serverTimestamp() : 123456789,
      comments: opts.comments ?? [],
      likes: opts.likes ?? 0,
      helpful: opts.helpful ?? 0,
    });
  });
}

// ============================================================
// フェーズ3A／3B 共通のシード
// ============================================================
// p1: 旧形式（createdAt 数値・authorUid なし）／comments 2件
await seed('p1', { comments: ['A', 'B'], likes: 3, helpful: 1 });
// p199: comments 199件（件数上限の境界テスト用）
await seed('p199', { comments: Array.from({ length: 199 }, (_, i) => 'c' + i) });
// p0c0: comments 0件（concat 検査：0件からの追記）
await seed('p0c0', { comments: [] });
// リアクション用（likes 3）
await seed('r1', { comments: ['X'], likes: 3, helpful: 0 });

// ============================================================
// フェーズ3A：新規投稿（C1〜C10）
// ============================================================
const newPost = (over = {}) => ({
  text: 'new post', category: '検討', history: HISTORY,
  authorUid: U1, createdAt: serverTimestamp(), comments: [], likes: 0, helpful: 0, ...over,
});

await check('3A C1 認証済み+authorUid本人+serverTimestamp → 作成許可', true,
  addDoc(collection(u1, 'posts'), newPost()));
await check('3A C2 未認証 → 作成拒否', false,
  addDoc(collection(anon, 'posts'), newPost()));
await check('3A C3 authorUid が他人 → 拒否', false,
  addDoc(collection(u1, 'posts'), newPost({ authorUid: U2 })));
await check('3A C4 authorUid なし → 拒否', false,
  addDoc(collection(u1, 'posts'), (() => { const o = newPost(); delete o.authorUid; return o; })()));
await check('3A C5 authorUid が数値 → 拒否', false,
  addDoc(collection(u1, 'posts'), newPost({ authorUid: 123 })));
await check('3A C6 createdAt が数値 → 拒否', false,
  addDoc(collection(u1, 'posts'), newPost({ createdAt: 123456789 })));
await check('3A C7 createdAt なし → 拒否', false,
  addDoc(collection(u1, 'posts'), (() => { const o = newPost(); delete o.createdAt; return o; })()));
await check('3A C8 未定義キー(title)を含む → 拒否', false,
  addDoc(collection(u1, 'posts'), newPost({ title: 'spam' })));
await check('3A C9 正常なmissIdx(1) を含む作成 → 許可', true,
  addDoc(collection(u1, 'posts'), newPost({ missIdx: 1 })));
await check('3A C10a missIdx=history.size と同じ(2) → 拒否', false,
  addDoc(collection(u1, 'posts'), newPost({ missIdx: 2 })));
await check('3A C10b missIdx=-1 → 拒否', false,
  addDoc(collection(u1, 'posts'), newPost({ missIdx: -1 })));
await check('3A C10c missIdx が文字列 → 拒否', false,
  addDoc(collection(u1, 'posts'), newPost({ missIdx: '1' })));
await check('3A C10d missIdx が null → 拒否', false,
  addDoc(collection(u1, 'posts'), newPost({ missIdx: null })));

// ============================================================
// フェーズ3A：既存投稿の更新（U1〜U6）／読み取り・削除（R1,R2）／D1
// p1（旧形式・comments [A,B]）を使う。※likes+1 のみの更新は3Bで「記録作成とセット」必須に变化。
// ============================================================
await check('3A U1 認証済みで comments 追記（arrayUnion）→ 許可', true,
  updateDoc(doc(u1, 'posts', 'p1'), { comments: arrayUnion('C') }));
await check('3A U3 未認証で comments 追記 → 拒否', false,
  updateDoc(doc(anon, 'posts', 'p1'), { comments: arrayUnion('Z') }));
await check('3A U4 未定義キー(missIdx)を既存投稿に追加 → 拒否', false,
  updateDoc(doc(u1, 'posts', 'p1'), { missIdx: 1 }));
await check('3A U5 本文(text)の書き換え → 拒否', false,
  updateDoc(doc(u1, 'posts', 'p1'), { text: 'hacked' }));
await check('3A U6 likes の減算 → 拒否', false,
  updateDoc(doc(u1, 'posts', 'p1'), { likes: 2 }));
await check('3A R1 未認証でも posts の読み取り → 許可', true,
  getDoc(doc(anon, 'posts', 'p1')));
await check('3A R2 認証済みでも posts の削除 → 拒否', false,
  deleteDoc(doc(u2, 'posts', 'p1')));
await check('3A D1 未定義コレクション other への書き込み → 拒否', false,
  setDoc(doc(anon, 'other', 'x'), { v: 1 }));
await check('3A D1b 未定義コレクション other への書き込み（認証済み）→ 拒否', false,
  setDoc(doc(u1, 'other', 'x'), { v: 1 }));

// ============================================================
// フェーズ3B-1：comments の追記専用（K1〜K11 ＋ concat の3ケース）
// ※ 実SDKの update は「配列全体の置換」または arrayUnion として送られる。
//   ルールはその新配列が「旧配列＋末尾1件」と一致するかで判定する。
// ============================================================
// K1: 追記1件（2→3）
await seed('k1', { comments: ['A', 'B'] });
await check('3B K1 comments 1件追記（A,B→A,B,C）→ 許可', true,
  updateDoc(doc(u1, 'posts', 'k1'), { comments: arrayUnion('C') }));

// K3: 書き換え＋追記同時（A→X に変えて C 追加）
await seed('k3', { comments: ['A', 'B'] });
await check('3B K3 既存書き換え＋追記の同時（X,B,C）→ 拒否', false,
  updateDoc(doc(u1, 'posts', 'k3'), { comments: ['X', 'B', 'C'] }));

// K4: 削除＋追記（B,C）
await seed('k4', { comments: ['A', 'B'] });
await check('3B K4 既存削除＋追記の同時（B,C）→ 拒否', false,
  updateDoc(doc(u1, 'posts', 'k4'), { comments: ['B', 'C'] }));

// K5: 並べ替え＋追記（B,A,C）
await seed('k5', { comments: ['A', 'B'] });
await check('3B K5 並べ替え＋追記の同時（B,A,C）→ 拒否', false,
  updateDoc(doc(u1, 'posts', 'k5'), { comments: ['B', 'A', 'C'] }));

// K6: 2件以上の追記
await seed('k6', { comments: ['A', 'B'] });
await check('3B K6 2件の同時追記（A,B,C,D）→ 拒否', false,
  updateDoc(doc(u1, 'posts', 'k6'), { comments: ['A', 'B', 'C', 'D'] }));

// K7: 501文字 / 500文字
const c500 = 'あ'.repeat(500);
const c501 = 'あ'.repeat(501);
await seed('k7', { comments: ['A'] });
await check('3B K7a 追加コメントが501文字 → 拒否', false,
  updateDoc(doc(u1, 'posts', 'k7'), { comments: arrayUnion(c501) }));
await check('3B K7b 追加コメントが500文字 → 許可', true,
  updateDoc(doc(u1, 'posts', 'k7'), { comments: arrayUnion(c500) }));

// K8: 空文字
await seed('k8', { comments: ['A'] });
await check('3B K8 追加コメントが空文字 → 拒否', false,
  updateDoc(doc(u1, 'posts', 'k8'), { comments: arrayUnion('') }));

// K9: 数値
await seed('k9', { comments: ['A'] });
await check('3B K9 追加コメントが数値 → 拒否', false,
  updateDoc(doc(u1, 'posts', 'k9'), { comments: arrayUnion(123) }));

// K10: 201件目
const c200 = [...Array.from({ length: 199 }, (_, i) => 'c' + i), 'c199'];
await check('3B K10a 199件→200件の追記 → 許可', true,
  updateDoc(doc(u1, 'posts', 'p199'), { comments: c200 }));
await check('3B K10b 201件目の追記 → 拒否', false,
  updateDoc(doc(u1, 'posts', 'p199'), { comments: [...c200, 'c200'] }));

// K11: comments キーの削除
await seed('k11', { comments: ['A'] });
await check('3B K11 comments キー自体の削除 → 拒否', false,
  updateDoc(doc(u1, 'posts', 'k11'), { comments: deleteField() }));

// concat の3ケース（ユーザー指定）
await check('3B 追加ケース1 comments 0件の投稿への追記（0→1）→ 許可', true,
  updateDoc(doc(u1, 'posts', 'p0c0'), { comments: ['X'] }));
// 既存200件を触っていない別投稿（p199b）で 199→200 を確認
await seed('p199b', { comments: Array.from({ length: 199 }, (_, i) => 'c' + i) });
await check('3B 追加ケース2 comments 199件の投稿への追記（199→200）→ 許可', true,
  updateDoc(doc(u1, 'posts', 'p199b'), { comments: [...Array.from({ length: 199 }, (_, i) => 'c' + i), 'c199'] }));
await check('3B 追加ケース3 書き換え＋追記の同時 → 拒否（K3と同じ）', false,
  updateDoc(doc(u1, 'posts', 'k3'), { comments: ['Y', 'B', 'Z'] }));
// arrayUnion 重複：同一文字列では配列が変化しない＝ルール上は「コメント不変の更新」として許可される。
// ⇒ クライアント側で重複チェックしないと「成功したように見えてコメントが増えない」事象になる（3B追加対応の根拠）。
await seed('dup1', { comments: ['A'] });
await check('3B 追加ケース4 同一文字列の arrayUnion（配列不変）→ 許可（無変化の更新）', true,
  updateDoc(doc(u1, 'posts', 'dup1'), { comments: arrayUnion('A') }));

// ============================================================
// フェーズ3B-2：リアクションの1人1回（R1〜R12）
// ============================================================
// R1: 初回（記録作成＋likes+1 の同時）
await check('3B-2 R1 初回：記録作成＋likes+1 の同時バッチ → 許可', true, (async () => {
  const b = writeBatch(u1);
  b.set(doc(u1, 'posts', 'r1', 'reactions', U1 + '_like'), { uid: U1, type: 'like', createdAt: serverTimestamp() });
  b.update(doc(u1, 'posts', 'r1'), { likes: increment(1) });
  return b.commit();
})());
// R2: 2回目（記録は既存）
await check('3B-2 R2 同じ本人の2回目 → 拒否', false, (async () => {
  const b = writeBatch(u1);
  b.set(doc(u1, 'posts', 'r1', 'reactions', U1 + '_like'), { uid: U1, type: 'like', createdAt: serverTimestamp() });
  b.update(doc(u1, 'posts', 'r1'), { likes: increment(1) });
  return b.commit();
})());
// R3: 他人のuidでの作成（ID不一致／uid不一致）
await check('3B-2 R3 他人のuid+type の記録作成 → 拒否', false,
  setDoc(doc(u1, 'posts', 'r1', 'reactions', U2 + '_like'), { uid: U2, type: 'like', createdAt: serverTimestamp() }));
// R4: 記録なしで likes+1（seed r4 を使い、記録なし状態から）
await seed('r4', { comments: [], likes: 3, helpful: 0 });
await check('3B-2 R4 リアクション記録なしで likes+1 → 拒否', false,
  updateDoc(doc(u1, 'posts', 'r4'), { likes: increment(1) }));
// R5: type 不正
await seed('r5', { comments: [], likes: 0, helpful: 0 });
await check('3B-2 R5 type=star の記録作成 → 拒否', false,
  setDoc(doc(u1, 'posts', 'r5', 'reactions', U1 + '_star'), { uid: U1, type: 'star', createdAt: serverTimestamp() }));
// R6: 記録だけ作る（posts を触らない）
await seed('r6', { comments: [], likes: 0, helpful: 0 });
await check('3B-2 R6a 記録のみ作成（posts を触らない）→ 許可', true,
  setDoc(doc(u1, 'posts', 'r6', 'reactions', U1 + '_helpful'), { uid: U1, type: 'helpful', createdAt: serverTimestamp() }));
await check('3B-2 R6b 記録作成なしでは likes+1 不可（記録は 既存）→ 拒否', false,
  updateDoc(doc(u1, 'posts', 'r6'), { likes: increment(1) }));
await check('3B-2 R6c 記録なしの helpful+1（作成なし）→ 拒否', false,
  updateDoc(doc(u1, 'posts', 'r6'), { helpful: increment(1) }));
// R7: comments 追記のみ（記録作成は不要）
await seed('r7', { comments: ['A'], likes: 0, helpful: 0 });
await check('3B-2 R7 comments 追記のみ（記録なし）→ 許可', true,
  updateDoc(doc(u1, 'posts', 'r7'), { comments: arrayUnion('B') }));
// R8: likes 減算
await check('3B-2 R8 likes の減算 → 拒否', false,
  updateDoc(doc(u1, 'posts', 'r1'), { likes: increment(-1) }));
// R9: reactions の一覧(list)
await check('3B-2 R9 reactions の一覧取得 list → 拒否', false,
  getDocs(collection(u1, 'posts', 'r7', 'reactions')));
// R10: 他人の記録の直接 get
await check('3B-2 R10 他人の記録の直接 get → 拒否', false,
  getDoc(doc(u1, 'posts', 'r1', 'reactions', U2 + '_like')));
// R11: 自分の記録の update（上書き）
await check('3B-2 R11 自分の記録の上書き → 拒否', false,
  setDoc(doc(u1, 'posts', 'r1', 'reactions', U1 + '_like'), { uid: U1, type: 'like', createdAt: serverTimestamp() }));
// R12: 自分の記録の delete
await check('3B-2 R12 自分の記録の削除 → 拒否', false,
  deleteDoc(doc(u1, 'posts', 'r1', 'reactions', U1 + '_like')));
// 補足：自分の記録の get は許可（ルールどおり）
await check('3B-2 追加分 自分の記録の get → 許可', true,
  getDoc(doc(u1, 'posts', 'r1', 'reactions', U1 + '_like')));

// ============================================================
// 結果表の出力と成否判定
// ============================================================
console.log('\n===== ルールテスト結果 =====');
console.table(rows);
// 結果表をファイルにも出力（Windows コンソールの文字化け対策）
const lines = ['case\t期待\t結果\t備考'];
for (const r of rows) lines.push(`${r.ケース}\t${r.期待}\t${r.結果}\t${r.備考}`);
writeFileSync(path.join(here, 'results.txt'), lines.join('\n') + '\n', 'utf8');
const ng = rows.filter(r => r.結果 === '不合格');
if (ng.length > 0) {
  console.log('不合格 ' + ng.length + ' 件 → 失敗として終了します');
  testEnv.cleanup();
  process.exitCode = 1;
} else {
  console.log('全 ' + rows.length + ' 件 合格');
  await testEnv.cleanup();
}
