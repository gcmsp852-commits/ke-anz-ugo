/* =============================================================================
 * QRツイン 管理部48ビット 共通モジュール
 *
 * 生成ソフト（QR Twin Generator）と読取ソフト（index.html）の両方がこれを読み込む。
 * 仕様の解釈が2箇所に分かれてズレることを防ぐため、
 * 管理部・拡張管理部・構造導出・役割展開は必ずここを経由する。
 *
 * 旧32ビット管理部とは非互換。
 * ============================================================================= */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;   // Node
  if (root) root.QRTwinMgmt48 = api;                                        // ブラウザ
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* ---------------------------------------------------------------------------
   * 1. 管理部48ビットのフィールド定義
   *    位置は1始まり（仕様書の表記に合わせる）。先頭が最上位ビット。
   * ------------------------------------------------------------------------- */
  var FIELDS = [
    { key: "qrNo",            pos: 1,  width: 3 },  // 論理QR番号 0=第1LQR … 5=第6LQR
    { key: "systemStruBits",  pos: 4,  width: 4 },  // 物理構造
    { key: "colorSpec1",      pos: 8,  width: 8 },  // 第1PQRの使用色ビットマップ
    { key: "colorSpec2",      pos: 16, width: 8 },  // 第2PQRの使用色ビットマップ（単一QRは0）
    { key: "dataCompBits",    pos: 24, width: 3 },  // データ構成（論理構造）
    { key: "dataPosition",    pos: 27, width: 2 },  // 領域がデータ部にWEBデータIDを持つか
    { key: "webDataKind",     pos: 29, width: 3 },  // WEBデータ種別
    { key: "sameDataFlag",    pos: 32, width: 1 },
    { key: "sysEncFlag",      pos: 33, width: 1 },
    { key: "appEncFlag",      pos: 34, width: 1 },
    { key: "hasDateTime",     pos: 35, width: 1 },
    { key: "hasExpiry",       pos: 36, width: 1 },
    { key: "hasReaderId",     pos: 37, width: 1 },
    { key: "hasImageId",      pos: 38, width: 1 },  // 電子署名で表示する画像のID
    { key: "hasLocation",     pos: 39, width: 1 },
    { key: "hasMunicipality", pos: 40, width: 1 },
    { key: "readLimitBits",   pos: 41, width: 2 },  // 0=無制限 1=1回 2=3回 3=5回
    { key: "userIdBit",       pos: 43, width: 1 },
    { key: "paddingExt",      pos: 44, width: 2 },  // 埋め草領域への溢れ収容
    { key: "reserved",        pos: 46, width: 3 }
  ];
  var MGMT_BITS = 48;

  /* ---------------------------------------------------------------------------
   * 2. systemStruBits → 物理構造
   *    領域(LQR)数 = 各PQRのプレーン数の合計。プレーン数 = log2(色数)。
   *    ただし 1000 だけは埋草領域を第2領域として使うため別扱い。
   * ------------------------------------------------------------------------- */
  var SYSTEM_STRUCTURES = {
    // --- QRツイン（物理QR 2枚） ---
    "0000": { label: "QRツイン 白黒＋白黒", isTwin: true,  colors: [2, 2], regionCount: 2 },
    "0001": { label: "QRツイン 白黒＋4色",  isTwin: true,  colors: [2, 4], regionCount: 3 },
    "0010": { label: "QRツイン 白黒＋8色",  isTwin: true,  colors: [2, 8], regionCount: 4 },
    "0100": { label: "QRツイン 4色＋4色",   isTwin: true,  colors: [4, 4], regionCount: 4 },
    "0101": { label: "QRツイン 4色＋8色",   isTwin: true,  colors: [4, 8], regionCount: 5 },
    "0110": { label: "QRツイン 8色＋8色",   isTwin: true,  colors: [8, 8], regionCount: 6 },
    // --- QRコード（物理QR 1枚） ---
    "1000": { label: "QRコード 白黒",       isTwin: false, colors: [2],    regionCount: 2, secondRegionIsPadding: true },
    "1001": { label: "QRコード カラー4色",  isTwin: false, colors: [4],    regionCount: 2 },
    "1010": { label: "QRコード カラー8色",  isTwin: false, colors: [8],    regionCount: 3 },
    // --- QRコード++（値のみ予約。今回は生成しない） ---
    "1100": { label: "QRコード++ 白黒",     isTwin: false, colors: [2],    regionCount: 2, secondRegionIsAddon: true, notImplemented: true }
  };

  // 既定の使用色ビットマップ（位置は 黒・青・赤・紫・黄・シアン・緑・白 の順）
  var DEFAULT_COLOR_SPEC_1ST = 0xA9; // 10101001 黒赤黄白
  var DEFAULT_COLOR_SPEC_2ND = 0xC3; // 11000011 黒青緑白
  var COLOR_SPEC_ALL8        = 0xFF; // 11111111 全色

  var planesOf = function (colorCount) {
    return colorCount === 8 ? 3 : (colorCount === 4 ? 2 : 1);
  };

  /**
   * systemStruBits から構造を導出する。
   * @returns {object} isTwin / pqrCount / colors / planes / regionCount / lqrToPqr
   *   lqrToPqr[i] は 第(i+1)LQR の割当先 { pqr: 1|2, plane: 1..3 } または
   *   { pqr: 1, padding: true }（1000 の第2領域）
   */
  function deriveStructure(systemStruBits) {
    var key = normalizeBits(systemStruBits, 4);
    var def = SYSTEM_STRUCTURES[key];
    if (!def) return null;
    var planes = def.colors.map(planesOf);
    var lqrToPqr = [];
    if (def.secondRegionIsPadding || def.secondRegionIsAddon) {
      // 第1LQR＝シンボル本体、第2LQR＝埋草領域（1000）または付加領域（1100）
      lqrToPqr.push({ pqr: 1, plane: 1 });
      lqrToPqr.push(def.secondRegionIsPadding ? { pqr: 1, padding: true } : { pqr: 1, addon: true });
    } else {
      // 第1PQRが若い番号のLQRから順に取る
      for (var p = 0; p < planes.length; p++) {
        for (var k = 1; k <= planes[p]; k++) lqrToPqr.push({ pqr: p + 1, plane: k });
      }
    }
    return {
      bits: key,
      label: def.label,
      isTwin: def.isTwin,
      notImplemented: !!def.notImplemented,
      pqrCount: def.colors.length,
      colors: def.colors.slice(),
      planes: planes,
      regionCount: def.regionCount,
      secondRegionIsPadding: !!def.secondRegionIsPadding,
      secondRegionIsAddon: !!def.secondRegionIsAddon,
      lqrToPqr: lqrToPqr
    };
  }

  /* ---------------------------------------------------------------------------
   * 3. dataCompBits → 各LQRの役割と連続グループ
   *
   *    3領域以上は「3つの役割」を領域数に応じて引き伸ばす。
   *      役割A = 第1LQR ／ 役割B = 第2〜第(N-1)LQR ／ 役割C = 第N LQR
   *    連続になるかは各ケースに明記された指定のみで決まる（役割Bの展開＝連続ではない）。
   * ------------------------------------------------------------------------- */
  var ROLE = { PUBLIC: "公開", ENCRYPTED: "暗号化", SIGNATURE: "電子署名" };

  var DATA_COMP_PLANS = {
    // --- 2領域専用 ---
    "000": { regions: 2, label: "公開＋公開",           roles: [ROLE.PUBLIC, ROLE.PUBLIC],    continuous: null },
    // ★2026.08.09版仕様に合わせて 001/010/011 を入れ替えた。
    //   旧版（2026.08.08）は 001=暗号化 / 010=電子署名 / 011=連続 だった。
    "001": { regions: 2, label: "公開＋公開（連続）",   roles: [ROLE.PUBLIC, ROLE.PUBLIC],    continuous: "all" },
    "010": { regions: 2, label: "公開＋暗号化",         roles: [ROLE.PUBLIC, ROLE.ENCRYPTED], continuous: null },
    "011": { regions: 2, label: "公開＋電子署名",       roles: [ROLE.PUBLIC, ROLE.SIGNATURE], continuous: null },
    // --- 3領域以上（役割A/B/Cで表現） ---
    "100": { regions: 3, label: "ケース1 独立公開",     roleABC: [ROLE.PUBLIC, ROLE.PUBLIC,    ROLE.PUBLIC],    continuous: null },
    "101": { regions: 3, label: "ケース2 全体連続",     roleABC: [ROLE.PUBLIC, ROLE.PUBLIC,    ROLE.PUBLIC],    continuous: "all" },
    "110": { regions: 3, label: "ケース3 第2以降連続",  roleABC: [ROLE.PUBLIC, ROLE.ENCRYPTED, ROLE.ENCRYPTED], continuous: "fromSecond" },
    "111": { regions: 3, label: "ケース4 署名付き",     roleABC: [ROLE.PUBLIC, ROLE.ENCRYPTED, ROLE.SIGNATURE], continuous: "roleB" }
  };

  /**
   * 領域数とdataCompBitsから、LQRごとの役割と連続グループを解決する。
   * @returns {object} lqrs[] / continuousGroups[][] / signatureLqr / inputSlots[]
   */
  function resolveLqrPlan(systemStruBits, dataCompBits) {
    var st = deriveStructure(systemStruBits);
    if (!st) return null;
    var code = normalizeBits(dataCompBits, 3);
    var plan = DATA_COMP_PLANS[code];
    if (!plan) return null;
    var N = st.regionCount;
    // 2領域用コードと3領域以上用コードの取り違えを弾く
    if ((N === 2) !== (plan.regions === 2)) return null;

    var roles = [];
    var i;
    if (N === 2) {
      roles = plan.roles.slice();
    } else {
      for (i = 1; i <= N; i++) {
        if (i === 1) roles.push(plan.roleABC[0]);
        else if (i === N) roles.push(plan.roleABC[2]);
        else roles.push(plan.roleABC[1]);
      }
    }

    // 連続グループの解決（長さ1のグループは連続とみなさない）
    var groups = [];
    var seq = function (from, to) {
      var a = [];
      for (var v = from; v <= to; v++) a.push(v);
      return a;
    };
    if (plan.continuous === "all") groups.push(seq(1, N));
    else if (plan.continuous === "fromSecond") groups.push(seq(2, N));
    else if (plan.continuous === "roleB") groups.push(seq(2, N - 1));
    groups = groups.filter(function (g) { return g.length >= 2; });

    var lqrs = [];
    for (i = 1; i <= N; i++) {
      var gi = -1;
      for (var g = 0; g < groups.length; g++) if (groups[g].indexOf(i) >= 0) gi = g;
      lqrs.push({
        lqr: i,
        role: roles[i - 1],
        continuousGroup: gi >= 0 ? gi : null,
        assign: st.lqrToPqr[i - 1] || null
      });
    }

    var signatureLqr = null;
    for (i = 0; i < lqrs.length; i++) if (lqrs[i].role === ROLE.SIGNATURE) signatureLqr = lqrs[i].lqr;

    // UIに出す入力欄（連続グループは1欄にまとめ、署名は自動生成なので欄を出さない）
    var slots = [];
    var used = {};
    for (i = 0; i < lqrs.length; i++) {
      var e = lqrs[i];
      if (e.role === ROLE.SIGNATURE) continue;
      if (e.continuousGroup !== null) {
        if (used["g" + e.continuousGroup]) continue;
        used["g" + e.continuousGroup] = true;
        slots.push({ kind: "continuous", role: e.role, lqrs: groups[e.continuousGroup].slice() });
      } else {
        slots.push({ kind: "single", role: e.role, lqrs: [e.lqr] });
      }
    }

    return {
      structure: st,
      dataCompBits: code,
      label: plan.label,
      regionCount: N,
      lqrs: lqrs,
      continuousGroups: groups,
      signatureLqr: signatureLqr,
      inputSlots: slots
    };
  }

  /**
   * その構造で「実データを持つLQR」の本数。
   *   1000 の第2領域＝埋草領域は、仕様書のとおり実データを入れる領域なので数える
   *   （「1000 白黒2色の２領域（埋草領域が第２領域）」）。第2領域の中身は
   *   第1領域のビット列の終端より後ろ＝一般のQRリーダーには見えない位置に入る。
   *   数えないのは 1100 の付加領域だけ（値の予約のみで今回は生成しない）。
   */
  function dataLqrCount(systemStruBits) {
    var st = deriveStructure(systemStruBits);
    if (!st) return 0;
    return st.lqrToPqr.filter(function (a) { return a && !a.addon; }).length;
  }

  /**
   * 第2領域が「同じシンボルの埋草領域」に入る構造か（1000 だけ）。
   *   この構造は物理シンボルが1枚しかないので、第2領域だけを対象にした
   *   シンボル単位の処理（システム暗号化＝型式情報の書き換え）が成り立たない。
   *   書き換えると第1領域まで読めなくなり、「第1領域は公開」が崩れる。
   */
  function secondRegionInPadding(systemStruBits) {
    var st = deriveStructure(systemStruBits);
    return !!(st && st.secondRegionIsPadding);
  }

  /**
   * その構造が電子署名を載せられるかを返す。QRツイン・単一QRのどちらも同じ規則。
   *
   *   署名は役割C＝最終LQRに入る。1000 は第2領域（埋草領域）が署名の置き場になる。
   *   数えないのは 1100 の付加領域だけ。
   *
   *   2領域    → dataCompBits 011「公開＋電子署名」。ユーザ暗号化は併用しない。
   *   3領域以上 → 署名を持つのは 111「ケース4」だけで、役割B（第2〜第N-1LQR）が
   *               暗号化される。したがってユーザ暗号化が必須になる。
   *
   * @returns {object} ok / lqrCount / signatureLqr / requiresEncryption /
   *                   dataCompBits / reason（ok=false のときだけ理由が入る）
   */
  function signatureSupport(systemStruBits) {
    var st = deriveStructure(systemStruBits);
    if (!st) return { ok: false, reason: "systemStruBits が未定義の値です" };
    if (st.notImplemented) {
      return { ok: false, reason: st.label + " は実装対象外のため電子署名を載せられません" };
    }
    var lqrCount = st.lqrToPqr.filter(function (a) {
      return a && !a.addon;
    }).length;
    if (lqrCount < 2) {
      return {
        ok: false, lqrCount: lqrCount,
        reason: st.label + " は実データ領域が1つしかないため電子署名を載せられません"
      };
    }
    var threeOrMore = st.regionCount >= 3;
    return {
      ok: true,
      lqrCount: lqrCount,
      signatureLqr: lqrCount,
      requiresEncryption: threeOrMore,
      dataCompBits: threeOrMore ? "111" : "011",
      reason: null
    };
  }

  /* ---------------------------------------------------------------------------
   * 3-2. WEBデータID（dataPosition / webDataKind）
   *
   *   2領域構成に限り、片方のLQRのデータ部を「WEBデータID」にできる。
   *   読取側はそのIDを使って本体データをWEBから取得する想定で、
   *   webDataKind は取得される中身の種別を表す。
   * ------------------------------------------------------------------------- */

  /** dataPosition（2ビット）。添字＝値。webLqr は WEBデータIDを持つLQR番号。 */
  var DATA_POSITIONS = [
    { value: 0, label: "シンボル、シンボル",        webLqr: null },
    { value: 1, label: "シンボル、WEB（データID）", webLqr: 2 },
    { value: 2, label: "WEB（データID）、シンボル", webLqr: 1 },
    { value: 3, label: "未定義",                    webLqr: null, undefinedValue: true }
  ];

  /**
   * webDataKind（3ビット）。添字＝値。
   *
   * ★仕様書（2026.08.08）の表は「010 平文(文字列)」と「010 WEB アドレス」で
   *   値が重複しており、001 が欠けている。6つの定義値を昇順に並べると
   *   001＝平文(文字列) となるため、そちらの誤記として扱う。
   *   仕様が確定したらこの表だけを直せばよい。
   */
  var WEB_DATA_KINDS = [
    { value: 0, label: "WEBデータ無し" },
    { value: 1, label: "平文(文字列)" },
    { value: 2, label: "WEBアドレス" },
    { value: 3, label: "静止画像" },
    { value: 4, label: "動画" },
    { value: 5, label: "音声" },
    { value: 6, label: "未定義", undefinedValue: true },
    { value: 7, label: "未定義", undefinedValue: true }
  ];

  function dataPositionLabel(v) {
    var e = DATA_POSITIONS[v || 0];
    return e ? e.label : "未定義";
  }
  function webDataKindLabel(v) {
    var e = WEB_DATA_KINDS[v || 0];
    return e ? e.label : "未定義";
  }
  /** dataPosition が指す「WEBデータIDを持つLQR番号」。持たないなら null。 */
  function webDataLqrOf(dataPosition) {
    var e = DATA_POSITIONS[dataPosition || 0];
    return e ? e.webLqr : null;
  }

  /**
   * WEBデータID（32ビット）の内訳。
   *   上位26ビット＝ユーザID ／ 下位6ビット＝個別データID
   * 仕様書（2026.08.09）5. データ所在「データIDの構成 ユーザID＋個別データID」より。
   */
  var WEB_DATA_ID_USER_BITS = 26;
  var WEB_DATA_ID_ITEM_BITS = 6;
  var WEB_DATA_ID_USER_MAX = Math.pow(2, WEB_DATA_ID_USER_BITS) - 1;  // 67108863
  var WEB_DATA_ID_ITEM_MAX = Math.pow(2, WEB_DATA_ID_ITEM_BITS) - 1;  // 63

  /** ユーザID(26bit) と 個別データID(6bit) から32ビットのWEBデータIDを組み立てる */
  function composeWebDataId(userId26, itemId6) {
    var u = Number(userId26) || 0;
    var i = Number(itemId6) || 0;
    if (u < 0 || u > WEB_DATA_ID_USER_MAX) return null;
    if (i < 0 || i > WEB_DATA_ID_ITEM_MAX) return null;
    // 26ビット左シフトは 32ビット符号付き演算で溢れるため、乗算で組み立てる
    return ((u * Math.pow(2, WEB_DATA_ID_ITEM_BITS)) + i) >>> 0;
  }

  /** 32ビットのWEBデータIDを ユーザID / 個別データID へ分解する */
  function parseWebDataId(value32) {
    var v = (Number(value32) || 0) >>> 0;
    return {
      userId: Math.floor(v / Math.pow(2, WEB_DATA_ID_ITEM_BITS)),
      itemId: v % Math.pow(2, WEB_DATA_ID_ITEM_BITS),
      value: v
    };
  }

  /**
   * その構成でWEBデータIDを使えるか、使えるならどのLQRに置けるかを返す。
   *   ・2領域構成に限る（R1）
   *   ・電子署名のLQRは置き換えられない（R4）
   * @returns {object} ok / allowedLqrs / reason
   */
  function webDataSupport(systemStruBits, dataCompBits) {
    var st = deriveStructure(systemStruBits);
    if (!st) return { ok: false, allowedLqrs: [], reason: "systemStruBits が未定義の値です" };
    if (st.notImplemented) {
      return { ok: false, allowedLqrs: [], reason: st.label + " は実装対象外です" };
    }
    if (st.regionCount !== 2) {
      return {
        ok: false, allowedLqrs: [],
        reason: "WEBデータIDは2領域構成だけで使えます（" + st.label + " は" + st.regionCount + "領域）"
      };
    }
    var plan = resolveLqrPlan(st.bits, dataCompBits);
    var allowed = [];
    for (var i = 1; i <= 2; i++) {
      if (plan && plan.signatureLqr === i) continue;   // R4: 署名のLQRは置き換え不可
      allowed.push(i);
    }
    if (!allowed.length) {
      return { ok: false, allowedLqrs: [], reason: "置き換えられるLQRがありません" };
    }
    return { ok: true, allowedLqrs: allowed, reason: null };
  }

  /* ---------------------------------------------------------------------------
   * 4. 管理部48ビットの組立・解析
   * ------------------------------------------------------------------------- */
  function normalizeBits(v, width) {
    if (typeof v === "number") return toBits(v, width);
    var s = String(v == null ? "" : v).replace(/[^01]/g, "");
    if (s.length === width) return s;
    if (s.length < width) return s.padStart(width, "0");
    return s.slice(-width);
  }
  function toBits(value, width) {
    var n = Math.max(0, Number(value) || 0) >>> 0;
    return n.toString(2).padStart(width, "0").slice(-width);
  }

  /**
   * 管理部48ビットを組み立てる。
   * @param {object} parts 各フィールド値（数値 or ビット文字列。真偽値も可）
   * @returns {object} { bits, high16, mid16, low16 }
   */
  function buildMgmt48(parts) {
    var p = parts || {};
    var out = "";
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      var v = p[f.key];
      if (v === undefined || v === null) v = 0;
      if (typeof v === "boolean") v = v ? 1 : 0;
      out += (typeof v === "string") ? normalizeBits(v, f.width) : toBits(v, f.width);
    }
    if (out.length !== MGMT_BITS) throw new Error("管理部のビット数が不正です: " + out.length);
    return {
      bits: out,
      high16: parseInt(out.slice(0, 16), 2),
      mid16: parseInt(out.slice(16, 32), 2),
      low16: parseInt(out.slice(32, 48), 2)
    };
  }

  /**
   * 管理部48ビットを解析する。
   * @param {string|object} src 48文字のビット列、または { high16, mid16, low16 }
   */
  function parseMgmt48(src) {
    var bits;
    if (typeof src === "string") {
      bits = src.replace(/[^01]/g, "");
    } else if (src && typeof src === "object") {
      if (src.high16 === undefined || src.mid16 === undefined || src.low16 === undefined) return null;
      bits = toBits(src.high16, 16) + toBits(src.mid16, 16) + toBits(src.low16, 16);
    } else {
      return null;
    }
    if (bits.length !== MGMT_BITS) return null;
    var r = { bits: bits };
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      var seg = bits.substr(f.pos - 1, f.width);
      r[f.key] = parseInt(seg, 2);
      if (f.width === 1) r[f.key] = r[f.key] === 1;   // 1ビットは真偽値で返す
      r[f.key + "Bits"] = seg;
    }
    // 数値で扱いたいものは数値のまま残す
    r.qrNo = parseInt(bits.substr(0, 3), 2);
    return r;
  }

  /* ---------------------------------------------------------------------------
   * 5. 拡張管理部
   *    管理部のビット位置が早い順に、固定幅で連結する。
   *    長さフィールドは持たない（フラグを見れば構成が確定するため）。
   * ------------------------------------------------------------------------- */
  var EXT_ITEMS = [
    // ★WEBデータID（32ビット）。dataPosition が 00 以外のときだけ入る。
    //   拡張管理部は「管理部のビット位置が早い順」に並べる規則なので、
    //   dataPosition(27) は hasDateTime(35) より前＝拡張管理部の先頭に来る。
    { key: "webDataId",        width: 32, when: function (m) { return (m.dataPosition || 0) !== 0; } },
    { key: "creationDateTime", width: 32, when: function (m) { return !!m.hasDateTime; } },
    { key: "expiry",           width: 32, when: function (m) { return !!m.hasExpiry; } },
    { key: "readerId",         width: 32, when: function (m) { return !!m.hasReaderId; } },
    { key: "imageId",          width: 32, when: function (m) { return !!m.hasImageId; } },
    { key: "location",         width: 48, when: function (m) { return !!m.hasLocation; } },   // 緯度24＋経度24
    { key: "municipality",     width: 24, when: function (m) { return !!m.hasMunicipality; } },
    { key: "qrTwinUniqueId",   width: 8,  when: function (m) { return (m.readLimitBits || 0) > 0; } },
    { key: "userId",           width: 32, when: function (m) { return !!m.userIdBit; } }
  ];
  var EXT_MAX_BITS = EXT_ITEMS.reduce(function (a, b) { return a + b.width; }, 0);  // 240

  /** 拡張管理部を組み立てる。values は { creationDateTime: 数値, location: {lat, lon} … } */
  function buildMgmtExt(mgmt, values) {
    var v = values || {};
    var out = "";
    for (var i = 0; i < EXT_ITEMS.length; i++) {
      var it = EXT_ITEMS[i];
      if (!it.when(mgmt)) continue;
      if (it.key === "location") {
        var loc = v.location || {};
        out += toBits(loc.lat, 24) + toBits(loc.lon, 24);
      } else {
        out += toBits(v[it.key], it.width);
      }
    }
    return out;
  }

  /** 拡張管理部を解析する。bits は管理部48ビットの直後から始まるビット列。 */
  function parseMgmtExt(mgmt, bits) {
    var s = String(bits || "").replace(/[^01]/g, "");
    var r = {}, off = 0;
    for (var i = 0; i < EXT_ITEMS.length; i++) {
      var it = EXT_ITEMS[i];
      if (!it.when(mgmt)) continue;
      if (off + it.width > s.length) return null;   // 足りない＝壊れている
      var seg = s.substr(off, it.width);
      off += it.width;
      if (it.key === "location") {
        r.location = { lat: parseInt(seg.slice(0, 24), 2), lon: parseInt(seg.slice(24), 2) };
      } else {
        r[it.key] = parseInt(seg, 2);
      }
    }
    r._consumedBits = off;
    return r;
  }

  /** そのフラグ構成で拡張管理部が何ビットになるかを返す */
  function mgmtExtBitLength(mgmt) {
    var n = 0;
    for (var i = 0; i < EXT_ITEMS.length; i++) if (EXT_ITEMS[i].when(mgmt)) n += EXT_ITEMS[i].width;
    return n;
  }

  /* ---------------------------------------------------------------------------
   * 6. 整合性チェック（R1〜R5）
   * ------------------------------------------------------------------------- */
  function validateMgmt(mgmt) {
    var errors = [];
    var st = deriveStructure(mgmt.systemStruBitsBits || toBits(mgmt.systemStruBits, 4));
    if (!st) { return { ok: false, errors: ["systemStruBits が未定義の値です"] }; }
    if (st.notImplemented) errors.push(st.label + " は今回の実装対象外です");

    var N = st.regionCount;
    var plan = resolveLqrPlan(st.bits, toBits(mgmt.dataCompBits, 3));
    if (!plan) errors.push("dataCompBits が領域数(" + N + ")に対応していません");

    // qrNo は領域数の範囲内
    if (mgmt.qrNo >= N) errors.push("qrNo(" + mgmt.qrNo + ") が領域数(" + N + ")を超えています");

    var dp = mgmt.dataPosition || 0;
    var wk = mgmt.webDataKind || 0;

    // R1: 3領域以上は dataPosition / webDataKind とも 0
    if (N >= 3) {
      if (dp !== 0) errors.push("R1: 3領域以上では dataPosition は00固定です");
      if (wk !== 0) errors.push("R1: 3領域以上では WebDataKind は000固定です");
    }
    // R2 / R3: dataPosition と webDataKind は同時に立つか同時に0
    if (dp !== 0 && wk === 0) errors.push("R2: dataPosition が指定されている場合 WebDataKind は必須です");
    if (dp === 0 && wk !== 0) errors.push("R3: dataPosition が00の場合 WebDataKind は000にしてください");
    if (dp === 3) errors.push("dataPosition の 11 は未定義です");
    if (wk === 6 || wk === 7) errors.push("WebDataKind の 110/111 は未定義です");

    // R4: dataPosition が指すLQRが電子署名であってはならない
    if (plan && dp !== 0) {
      var target = (dp === 1) ? 2 : 1;   // 01=第2LQR / 10=第1LQR
      if (plan.signatureLqr === target) errors.push("R4: 電子署名のLQRを WEBデータID で置き換えることはできません");
    }

    // ★実データが1本しかない構造（1100の付加領域は未実装）では、
    //   2領域を前提にした指定を弾く。対象が無いまま管理部だけ立つと、
    //   読取側が存在しない相手を探し続ける。
    if (dataLqrCount(st.bits) < 2) {
      if (toBits(mgmt.dataCompBits, 3) !== "000") {
        errors.push(st.label + " は実データが1領域なので dataCompBits は000だけです");
      }
      if (mgmt.appEncFlag) errors.push(st.label + " は暗号化する領域を持ちません");
      if (dp !== 0) errors.push(st.label + " はWEBデータIDを持てません");
      if ((mgmt.paddingExt || 0) !== 0) errors.push(st.label + " は埋め草領域拡張を使えません");
    }

    // ★1000（第2領域＝同じシンボルの埋草領域）はシステム暗号化を使えない。
    //   システム暗号化は「第2領域のシンボルの型式情報を書き換える」処理なので、
    //   シンボルが1枚しかないこの構造では第1領域まで読めなくなる。
    //   第2領域を隠したいときはユーザ暗号化（埋草に入れるバイト列のXOR）を使う。
    if (secondRegionInPadding(st.bits) && mgmt.sysEncFlag) {
      errors.push(st.label + " は第2領域が同じシンボルの埋草領域なので sysEncFlag を使えません");
    }

    // sameDataFlag / paddingExt は 0000 と 1001 のみ
    var allowSame = (st.bits === "0000" || st.bits === "1001");
    if (mgmt.sameDataFlag && !allowSame) errors.push("sameDataFlag は 0000 と 1001 でのみ有効です");
    if ((mgmt.paddingExt || 0) !== 0) {
      if (!allowSame) errors.push("paddingExt は 0000 と 1001 でのみ有効です");
      if (mgmt.sameDataFlag) errors.push("sameData が有効なとき paddingExt は00にしてください");
      if ((mgmt.paddingExt || 0) === 3) errors.push("paddingExt の 11 は未定義です");
    }

    // 暗号化フラグと dataCompBits の整合
    if (plan) {
      var hasEnc = plan.lqrs.some(function (e) { return e.role === ROLE.ENCRYPTED; });
      if (hasEnc && !mgmt.appEncFlag && !mgmt.sysEncFlag) {
        errors.push("暗号化領域があるのに sysEncFlag / appEncFlag がどちらも立っていません");
      }
    }
    // 単一QRは第2PQRの色指定を持たない
    if (!st.isTwin && (mgmt.colorSpec2 || 0) !== 0) errors.push("単一QR構成では 2nd PQR colorSpecBits は0にしてください");

    return { ok: errors.length === 0, errors: errors, structure: st, plan: plan };
  }

  /* ---------------------------------------------------------------------------
   * 7. モジュール配置（色プレーンの逆順配置に使う）
   *
   *    読取側 jsQR の buildFunctionPatternMask / readCodewords と同じ規則。
   *    生成ソフトの汚損機能にも同じ実装が別に存在していたため、ここへ集約する。
   * ------------------------------------------------------------------------- */

  /**
   * 位置合わせパターンの中心座標（JIS X 0510 / ISO/IEC 18004 の表E.1）。
   * 添字＝型番。型番1は位置合わせパターンを持たない。
   *
   * ★読取ソフトは qrcode.js を読み込まないため、外部依存では型番2以上で
   *   機能パターンの範囲を誤り、データモジュールの走査順がずれる
   *   （例: 型番3で 592個 と数えてしまう。正しくは 567個）。
   *   規格表を内蔵して、生成・読取のどちらでも同じ順序になるようにする。
   */
  var ALIGNMENT_CENTERS = [
    [],
    [],                                   // 1
    [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
    [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82],
    [6, 30, 58, 86], [6, 34, 62, 90],
    [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106],
    [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118],
    [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130],
    [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142],
    [6, 34, 62, 90, 118, 146],
    [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158],
    [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170]
  ];

  /** 型番から位置合わせパターンの中心座標を得る */
  function alignmentCentersOf(typeNumber, provided) {
    if (Array.isArray(provided)) return provided;
    var g = (typeof globalThis !== "undefined" ? globalThis : null);
    if (g && g.qrcode && typeof g.qrcode.getAlignmentPositions === "function") {
      var fromQr = g.qrcode.getAlignmentPositions(typeNumber);
      if (Array.isArray(fromQr)) return fromQr;
    }
    return ALIGNMENT_CENTERS[typeNumber] || [];
  }

  /** 機能パターン（ファインダ・タイミング・位置合わせ等）のマスクを作る */
  function functionPatternMask(typeNumber, alignmentCenters) {
    var dim = 17 + 4 * typeNumber;
    var M = [];
    for (var y = 0; y < dim; y++) {
      M.push(new Array(dim).fill(false));
    }
    var reg = function (x, y, w, h) {
      for (var j = y; j < y + h; j++) {
        for (var i = x; i < x + w; i++) {
          if (i >= 0 && j >= 0 && i < dim && j < dim) M[j][i] = true;
        }
      }
    };
    reg(0, 0, 9, 9); reg(dim - 8, 0, 8, 9); reg(0, dim - 8, 9, 8);
    var centers = alignmentCentersOf(typeNumber, alignmentCenters);
    for (var a = 0; a < centers.length; a++) {
      for (var b = 0; b < centers.length; b++) {
        var cx = centers[a], cy = centers[b];
        if (!(cx === 6 && cy === 6 || cx === 6 && cy === dim - 7 || cx === dim - 7 && cy === 6)) {
          reg(cx - 2, cy - 2, 5, 5);
        }
      }
    }
    reg(6, 9, 1, dim - 17); reg(9, 6, dim - 17, 1);
    if (typeNumber > 6) { reg(dim - 11, 0, 3, 6); reg(0, dim - 11, 6, 3); }
    return M;
  }

  /**
   * データモジュールの走査順（右下から始まるジグザグ）を返す。
   * 要素は [列, 行]。先頭がビット0の置き場所。
   */
  function dataModuleOrder(typeNumber, alignmentCenters) {
    var dim = 17 + 4 * typeNumber;
    var fm = functionPatternMask(typeNumber, alignmentCenters);
    var order = [];
    var up = true;
    for (var col = dim - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (var i = 0; i < dim; i++) {
        var y = up ? dim - 1 - i : i;
        for (var off = 0; off < 2; off++) {
          var x = col - off;
          if (!fm[y][x]) order.push([x, y]);
        }
      }
      up = !up;
    }
    return order;
  }

  /**
   * ★逆順配置：第2領域のビットを走査順の逆から詰めるための並びを返す。
   *
   * 4色QRコード（systemStruBits=1001）で同一データを入れる場合、
   * 2つの領域は同じ物理モジュールを共有するため、素直に並べると
   * 汚れが両領域の同じコード語を同時に壊してしまい冗長性が得られない。
   * 第2領域だけ逆順に詰めることで、同じ汚れが両領域の別々のコード語に散り、
   * 段階2（ブロック単位の採用）・段階3（消失訂正）が機能するようになる。
   */
  function reversedModuleOrder(order) {
    return order.slice().reverse();
  }

  /** 逆順配置が必要な構成か（1001 かつ同一データのときのみ） */
  function needsReversedSecondPlane(systemStruBits, sameDataFlag) {
    return normalizeBits(systemStruBits, 4) === "1001" && !!sameDataFlag;
  }

  /**
   * LQRの並び（第1LQR, 第2LQR, …）を、物理QRごとのプレーン束へ振り分ける。
   *
   * 現行の生成ソフトは「第1PQR＝白黒1枚、第2PQR＝残り全部」という前提が
   * 描画処理に直接埋め込まれている。この関数を通すことで、
   * 第1PQRも複数プレーンを持つ構成（4色＋4色 など）へ拡張できる。
   *
   * @param {string} systemStruBits 構造4ビット
   * @param {Array} lqrItems 第1LQRから順に並べた任意の要素（行列など）
   * @returns {Array<{pqr:number, colorCount:number, planeCount:number, planes:Array,
   *                  isPadding:boolean, isAddon:boolean}>} PQRごとの束（第1PQRから順）
   */
  function groupPlanesByPqr(systemStruBits, lqrItems) {
    var st = deriveStructure(systemStruBits);
    if (!st) return null;
    var items = lqrItems || [];
    var groups = [];
    for (var p = 0; p < st.pqrCount; p++) {
      groups.push({
        pqr: p + 1,
        colorCount: st.colors[p],
        planeCount: st.planes[p],
        planes: [],
        isPadding: false,
        isAddon: false
      });
    }
    for (var i = 0; i < st.lqrToPqr.length; i++) {
      var a = st.lqrToPqr[i];
      var g = groups[a.pqr - 1];
      if (!g) continue;
      if (a.padding) { g.isPadding = true; continue; }   // 1000：埋草領域は色プレーンではない
      if (a.addon) { g.isAddon = true; continue; }       // 1100：付加領域（今回は生成しない）
      g.planes.push(items[i]);
    }
    return groups;
  }

  /* ---------------------------------------------------------------------------
   * 8. プレーン ↔ 色の対応
   *
   *    1つのPQRは色数に応じて複数のビットプレーン（＝LQR）を運ぶ。
   *    各モジュールの色は、そのモジュールにおける各プレーンの明暗の組で決まる。
   *    生成側と読取側でこの対応がズレると全滅するため、ここに一本化する。
   *
   *    色の並びは管理部 colorSpecBits と同じ：黒・青・赤・紫・黄・シアン・緑・白
   * ------------------------------------------------------------------------- */
  var COLOR_NAMES = ["black", "blue", "red", "purple", "yellow", "cyan", "green", "white"];
  var COLOR_RGB_TABLE = {
    black:  [0, 0, 0],     blue:  [0, 0, 255],   red:   [255, 0, 0],   purple: [255, 0, 255],
    yellow: [255, 255, 0], cyan:  [0, 255, 255], green: [0, 255, 0],   white:  [255, 255, 255]
  };

  // 3プレーン（8色）の対応表。生成ソフトの drawQuadColorQR と同一。
  //   添字 = (p1<<2)|(p2<<1)|p3   （1=暗, 0=明）
  var PLANE3_TO_COLOR = [7, 4, 5, 6, 3, 2, 1, 0];
  //   000→白(7) 001→黄(4) 010→シアン(5) 011→緑(6)
  //   100→紫(3) 101→赤(2)  110→青(1)     111→黒(0)

  // 1プレーン（白黒）：暗→黒(0) / 明→白(7)
  var PLANE1_TO_COLOR = [7, 0];

  /** colorSpecBits(8bit) で「使用する」とされた色の番号一覧を返す（暗い順＝上位ビット順） */
  function colorsFromSpec(colorSpec) {
    var list = [];
    for (var i = 0; i < 8; i++) {
      if (((colorSpec >> (7 - i)) & 1) === 1) list.push(i);
    }
    return list;
  }

  /**
   * プレーンの明暗の組から色番号(0..7)を求める。
   * @param {boolean[]} planeBits 各プレーンの暗さ（true=暗）。長さ1〜3。
   * @param {number} [colorSpec] 4色構成のときに使う使用色ビットマップ。
   *
   * ・1プレーン（白黒）と3プレーン（8色）は固定表を使う。
   *   既に発行済みのQRと互換を保つため、生成ソフトの既存テーブルをそのまま採用している。
   * ・2プレーン（4色）は colorSpecBits で指定された4色を、
   *   上位ビット（暗い側）から順に「暗い組み合わせ」へ割り当てる。
   *     両プレーン暗 → 指定色の1番目（最も暗い）
   *     両プレーン明 → 指定色の4番目（最も明るい）
   */
  function planesToColorIndex(planeBits, colorSpec) {
    var n = planeBits.length;
    var v = 0;
    for (var i = 0; i < n; i++) v = (v << 1) | (planeBits[i] ? 1 : 0);
    if (n === 1) return PLANE1_TO_COLOR[v];
    if (n === 3) return PLANE3_TO_COLOR[v];
    if (n === 2) {
      var colors = colorsFromSpec(colorSpec === undefined ? DEFAULT_COLOR_SPEC_1ST : colorSpec);
      if (colors.length !== 4) return 7;
      return colors[3 - v];   // v=3(両方暗)→最も暗い色 … v=0(両方明)→最も明るい色
    }
    return 7;
  }

  /* ---------------------------------------------------------------------------
   * ユーザID（32ビット）の国別構成
   *
   *   仕様書（2026.08.09）7. ユーザID より。
   *     ユーザID32ビット ＝ 国ID（4〜8ビット）＋ 個別ID（24〜28ビット）
   *
   *   国IDは可変長なので、頭部一致で一意に切り出せる必要がある（接尾符号）。
   *   下表がその条件を満たしていることは検証で確かめている。
   *
   *   ★米国は仕様書の表では「国ID 00001（5ビット）／個別ID 28ビット」で
   *     合計33ビットになり32ビットに収まらない。件数の「1.3億」は 2^27 に一致する
   *     （2^28 は2.6億）ので、個別IDは27ビットの誤記として扱う。
   * ------------------------------------------------------------------------- */
  var USER_ID_BITS = 32;
  var USER_ID_COUNTRIES = [
    { name: "日本",         code: "00000",  individualBits: 27 },
    { name: "米国",         code: "00001",  individualBits: 27 },   // ★表は28ビット（誤記）
    { name: "インドネシア", code: "0001",   individualBits: 28 },
    { name: "中国",         code: "001",    individualBits: 29 },
    { name: "インド",       code: "010",    individualBits: 29 },
    { name: "台湾",         code: "100001", individualBits: 26 },
    { name: "ベトナム",     code: "100010", individualBits: 26 },
    { name: "韓国",         code: "100011", individualBits: 26 }
  ];

  function userIdCountryByName(name) {
    for (var i = 0; i < USER_ID_COUNTRIES.length; i++) {
      if (USER_ID_COUNTRIES[i].name === name) return USER_ID_COUNTRIES[i];
    }
    return null;
  }
  function userIdCountryByCode(code) {
    for (var i = 0; i < USER_ID_COUNTRIES.length; i++) {
      if (USER_ID_COUNTRIES[i].code === code) return USER_ID_COUNTRIES[i];
    }
    return null;
  }
  /** その国で使える個別IDの最大値 */
  function userIdIndividualMax(country) {
    if (!country) return 0;
    return Math.pow(2, country.individualBits) - 1;
  }

  /**
   * 国名（または国IDのビット列）と個別IDから32ビットのユーザIDを組み立てる。
   * @returns {number|null} 範囲外なら null
   */
  function composeUserId(countryNameOrCode, individualId) {
    var c = userIdCountryByName(countryNameOrCode) || userIdCountryByCode(countryNameOrCode);
    if (!c) return null;
    var v = Number(individualId);
    if (!isFinite(v) || v < 0 || v > userIdIndividualMax(c)) return null;
    // 国IDを個別IDのビット数ぶん上位へ置く。32ビット左シフトは符号付き演算で
    // 溢れるため、乗算で組み立てる。
    var prefix = parseInt(c.code, 2);
    return ((prefix * Math.pow(2, c.individualBits)) + v) >>> 0;
  }

  /**
   * 32ビットのユーザIDを 国 / 個別ID へ分解する。
   * 国IDは可変長なので、上位ビットから順に一致する国を探す（接尾符号）。
   * @returns {object|null} 未割当の国IDなら null
   */
  function parseUserId(value32) {
    var v = (Number(value32) || 0) >>> 0;
    var bits = "";
    for (var b = USER_ID_BITS - 1; b >= 0; b--) {
      bits += (Math.floor(v / Math.pow(2, b)) % 2) ? "1" : "0";
    }
    for (var i = 0; i < USER_ID_COUNTRIES.length; i++) {
      var c = USER_ID_COUNTRIES[i];
      if (bits.slice(0, c.code.length) !== c.code) continue;
      return {
        country: c,
        countryName: c.name,
        countryCode: c.code,
        individualId: parseInt(bits.slice(c.code.length), 2),
        value: v
      };
    }
    return null;
  }

  /* ---------------------------------------------------------------------------
   * システムパスワード
   *
   *   仕様書（2026.08.09）で決め打ちされている固定パスワード。
   *   どちらも「SHA256でハッシュ値を生成し、それを鍵ストリームとしてXOR」する。
   *   鍵ストリームの伸ばし方は既存のユーザ暗号化と同じ連鎖ハッシュ
   *   （h0 = SHA256(入力) / h1 = SHA256(h0) / … を必要バイト数ぶん連結）。
   *
   *   ・systempassword  … 5. データ所在
   *       「システム暗号化が指定される場合は、システムパスワードで暗号化した
   *         結果がWEBに記録される」
   *   ・paddingpassword … 8. 埋め草領域拡張
   *       「大量データ側が暗号化されている場合には、5.のWEBデータ記憶と同様に
   *         暗号化後、収容する」
   * ------------------------------------------------------------------------- */
  var SYSTEM_PASSWORD  = "systempassword";
  var PADDING_PASSWORD = "paddingpassword";

  /**
   * WEBへ記録するデータをどの鍵で暗号化するかを決める。
   *   ・ユーザ暗号化が指定されていれば、その指定パスワード
   *     （QRツインに収容する場合と同じ。システム暗号化は行わない）
   *   ・そうでなくシステム暗号化が指定されていれば systempassword
   *   ・どちらでもなければ暗号化しない
   * @returns {object} kind: "app"|"system"|"none" / password（none のときは null）
   */
  function webDataMaskSpec(mgmt, appEncPassword) {
    if (mgmt && mgmt.appEncFlag) {
      return { kind: "app", password: appEncPassword || null };
    }
    if (mgmt && mgmt.sysEncFlag) {
      return { kind: "system", password: SYSTEM_PASSWORD };
    }
    return { kind: "none", password: null };
  }

  /**
   * 埋め草領域拡張へ収容するデータの鍵。
   *   仕様書 8.「大量データ側が暗号化されている場合には、5.のWEBデータ記憶と同様に
   *   暗号化後、収容する。システムパスワード『paddingpassword』とする。」
   *   ＝ 収容元が暗号化されているときだけ、固定の paddingpassword で暗号化する。
   *   （5. と違い、ユーザ指定パスワードは使わない。仕様書が固定値を明示しているため）
   * @param {object} mgmt 収容元LQRの管理部
   */
  function paddingMaskSpec(mgmt) {
    var encrypted = !!(mgmt && (mgmt.appEncFlag || mgmt.sysEncFlag));
    return encrypted
      ? { kind: "padding", password: PADDING_PASSWORD }
      : { kind: "none", password: null };
  }

  /* ---------------------------------------------------------------------------
   * 埋め草領域拡張（paddingExt）の格納書式
   *
   *   仕様書 8. は「どちらのLQRへ収容するか」しか定めておらず、収容した長さを
   *   読取側へ伝える手段が無い。そこで拡張データ部の先頭に16ビットの長さを置く。
   *
   *     拡張データ部 = 長さ16ビット（バイト数, ビッグエンディアン） + 本体バイト列
   *
   *   位置は管理部（拡張管理部と終端4ビットを含む）の直後、埋め草の手前。
   *   仕様書p.21の図「データ部｜管理部｜拡張データ部｜埋｜訂正データ部」と一致する。
   * ------------------------------------------------------------------------- */
  var PADDING_EXT_LENGTH_BITS = 16;
  var PADDING_EXT_MAX_BYTES = 65535;

  /** paddingExt の値から「拡張データ部を持つLQR番号」を返す。持たないなら null。 */
  function paddingExtHolderLqr(paddingExt) {
    if (paddingExt === 1) return 2;   // 01: LQR2 に LQR1 の余りを収容
    if (paddingExt === 2) return 1;   // 10: LQR1 に LQR2 の余りを収容
    return null;
  }
  /** paddingExt の値から「余りデータの出どころ（収容元）のLQR番号」を返す。 */
  function paddingExtSourceLqr(paddingExt) {
    if (paddingExt === 1) return 1;
    if (paddingExt === 2) return 2;
    return null;
  }

  /** 鍵ストリームでXORする（暗号化・復号の両方に使う。2回かけると元に戻る） */
  function xorWithMask(bytes, maskBytes) {
    var n = bytes.length;
    var out = (typeof Uint8Array !== "undefined" && bytes instanceof Uint8Array)
      ? new Uint8Array(n) : new Array(n);
    if (!maskBytes || !maskBytes.length) {
      for (var k = 0; k < n; k++) out[k] = bytes[k] & 0xFF;
      return out;
    }
    for (var i = 0; i < n; i++) {
      out[i] = (bytes[i] ^ maskBytes[i % maskBytes.length]) & 0xFF;
    }
    return out;
  }

  /**
   * ★同一データ4色QR（1001＋sameData）の符号化で使う、バイト列のビット逆転。
   *
   *   仕様書（2026.08.09）6.2「４色QRコードの符号化」より。
   *     ステップ1 データ部（埋め草含む）のビット列を逆順に並べ替える
   *     ステップ2 その データに対して RS符号の誤り訂正データを作成
   *     ステップ3 RS符号のデータ全体のビットの並びを逆転する
   *
   *   ビット列全体を逆順にするので、バイト順を反転し、さらに各バイト内の
   *   ビットも反転する。長さが変わらないため、2回かけると元へ戻る。
   */
  function bitReverseBytes(bytes) {
    var n = bytes.length;
    var out = (typeof Uint8Array !== "undefined" && bytes instanceof Uint8Array)
      ? new Uint8Array(n) : new Array(n);
    for (var i = 0; i < n; i++) {
      var v = bytes[n - 1 - i] & 0xFF;
      // バイト内のビット反転（8ビット）
      v = ((v & 0xF0) >> 4) | ((v & 0x0F) << 4);
      v = ((v & 0xCC) >> 2) | ((v & 0x33) << 2);
      v = ((v & 0xAA) >> 1) | ((v & 0x55) << 1);
      out[i] = v & 0xFF;
    }
    return out;
  }

  /** 色番号(0..7)から各プレーンの明暗へ戻す（読取側の逆変換） */
  function colorIndexToPlanes(colorIndex, planeCount, colorSpec) {
    var bits, i, v;
    var table = (planeCount === 1) ? PLANE1_TO_COLOR
              : (planeCount === 3) ? PLANE3_TO_COLOR : null;
    if (table) {
      for (v = 0; v < table.length; v++) {
        if (table[v] === colorIndex) {
          bits = [];
          for (i = planeCount - 1; i >= 0; i--) bits.push(((v >> i) & 1) === 1);
          return bits;
        }
      }
      return null;
    }
    if (planeCount === 2) {
      var colors = colorsFromSpec(colorSpec === undefined ? DEFAULT_COLOR_SPEC_1ST : colorSpec);
      var pos = colors.indexOf(colorIndex);
      if (pos < 0 || colors.length !== 4) return null;
      v = 3 - pos;
      return [((v >> 1) & 1) === 1, (v & 1) === 1];
    }
    return null;
  }

  /* ------------------------------------------------------------------------- */
  return {
    MGMT_BITS: MGMT_BITS,
    COLOR_NAMES: COLOR_NAMES,
    COLOR_RGB_TABLE: COLOR_RGB_TABLE,
    planesToColorIndex: planesToColorIndex,
    colorIndexToPlanes: colorIndexToPlanes,
    colorsFromSpec: colorsFromSpec,
    functionPatternMask: functionPatternMask,
    dataModuleOrder: dataModuleOrder,
    reversedModuleOrder: reversedModuleOrder,
    needsReversedSecondPlane: needsReversedSecondPlane,
    bitReverseBytes: bitReverseBytes,
    USER_ID_BITS: USER_ID_BITS,
    USER_ID_COUNTRIES: USER_ID_COUNTRIES,
    userIdCountryByName: userIdCountryByName,
    userIdCountryByCode: userIdCountryByCode,
    userIdIndividualMax: userIdIndividualMax,
    composeUserId: composeUserId,
    parseUserId: parseUserId,
    SYSTEM_PASSWORD: SYSTEM_PASSWORD,
    PADDING_PASSWORD: PADDING_PASSWORD,
    webDataMaskSpec: webDataMaskSpec,
    paddingMaskSpec: paddingMaskSpec,
    PADDING_EXT_LENGTH_BITS: PADDING_EXT_LENGTH_BITS,
    PADDING_EXT_MAX_BYTES: PADDING_EXT_MAX_BYTES,
    secondRegionInPadding: secondRegionInPadding,
    paddingExtHolderLqr: paddingExtHolderLqr,
    paddingExtSourceLqr: paddingExtSourceLqr,
    xorWithMask: xorWithMask,
    groupPlanesByPqr: groupPlanesByPqr,
    EXT_MAX_BITS: EXT_MAX_BITS,
    FIELDS: FIELDS,
    ROLE: ROLE,
    SYSTEM_STRUCTURES: SYSTEM_STRUCTURES,
    DATA_COMP_PLANS: DATA_COMP_PLANS,
    DEFAULT_COLOR_SPEC_1ST: DEFAULT_COLOR_SPEC_1ST,
    DEFAULT_COLOR_SPEC_2ND: DEFAULT_COLOR_SPEC_2ND,
    COLOR_SPEC_ALL8: COLOR_SPEC_ALL8,
    deriveStructure: deriveStructure,
    dataLqrCount: dataLqrCount,
    resolveLqrPlan: resolveLqrPlan,
    signatureSupport: signatureSupport,
    DATA_POSITIONS: DATA_POSITIONS,
    WEB_DATA_KINDS: WEB_DATA_KINDS,
    dataPositionLabel: dataPositionLabel,
    webDataKindLabel: webDataKindLabel,
    webDataLqrOf: webDataLqrOf,
    webDataSupport: webDataSupport,
    WEB_DATA_ID_USER_BITS: WEB_DATA_ID_USER_BITS,
    WEB_DATA_ID_ITEM_BITS: WEB_DATA_ID_ITEM_BITS,
    WEB_DATA_ID_USER_MAX: WEB_DATA_ID_USER_MAX,
    WEB_DATA_ID_ITEM_MAX: WEB_DATA_ID_ITEM_MAX,
    composeWebDataId: composeWebDataId,
    parseWebDataId: parseWebDataId,
    buildMgmt48: buildMgmt48,
    parseMgmt48: parseMgmt48,
    buildMgmtExt: buildMgmtExt,
    parseMgmtExt: parseMgmtExt,
    mgmtExtBitLength: mgmtExtBitLength,
    validateMgmt: validateMgmt
  };
});
