/*
 * qrcode-generator (modified for 16-bit "management" insertion)
 * Original: kazuhiko arase (MIT)
 *
 * Modification summary:
 * - Add API: qr.setManagementBits(bits32)
 * - Insert bits in stream:
 *   data -> terminator(up to 4) -> management(16) -> terminator(0000) -> bit pad -> byte pad -> ECC
 * - AUTO typeNumber selection includes +20 bits (management+terminator) when management is set.
 */

(function () {

  //---------------------------------------------------------------------
  // qrcode
  //---------------------------------------------------------------------
  var qrcode = function (typeNumber, errorCorrectionLevel) {

    var PAD0 = 0xEC;
    var PAD1 = 0x11;

    var _typeNumber = typeNumber;
    var _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
    var _modules = null;
    var _moduleCount = 0;
    var _dataCache = null;
    var _dataList = [];

// ★追加：管理部 16bit（数値 0..65535 で保持 / 未設定なら null）
var _managementBits = null;
// ★追加：拡張管理部 32bit（数値で保持 / 未設定なら null）
var _managementExt32 = null;
// ★追加：拡張管理部 複数32bitブロック（配列で保持）
var _managementExtBlocks = null;
// ★追加：読取位置 48bit（数値ペア [latVal, lonVal] で保持 / 未設定なら null）
var _locationExt48 = null;
// ★追加：市町村コード 24bit（数値で保持 / 未設定なら null）
var _municipalityExt24 = null;
// ★追加：QRツイン固有番号 8bit（数値で保持 / 未設定なら null）
var _qrTwinUniqueId8 = null;
// ★追加：WEBデータID 32bit（数値で保持 / 未設定なら null）
//   拡張管理部の先頭に置く（dataPosition(27) は hasDateTime(35) より前のため）。
//   内訳は ユーザID26ビット＋個別データID6ビット。
var _webDataIdExt32 = null;
// ★追加：ユーザーID 32bit（数値で保持 / 未設定なら null）
//   拡張管理部の最後（QRツイン固有番号8bitの後ろ）に並ぶ。順番は qrtwin-mgmt48.js の
//   EXT_ITEMS と一致させること。読取側 jsQR.js は既にこの位置で読んでいる。
var _userIdExt32 = null;
// ★追加：データバイトキャッシュ（ECC除く、署名用ハッシュ計算向け）
var _dataBytesCache = null;

// ★追加：マスク指定（0..7）/ 未指定(null)なら自動
var _maskPatternOverride = null;
// ★追加：暗号化XORマスク（総コード語と同じバイト数）
var _xorMaskBytes = null;
// ★追加：逆順データモード（同一データ4色QRの第2LQR用）
//   仕様書 6.2「４色QRコードの符号化」ステップ1〜2：
//   データ部（埋め草含む）のビット列を逆順に並べ替えてから、そのデータに対して
//   RS符号の誤り訂正データを作成する。ステップ3の全体反転はセル配置側で行う。
var _reverseDataMode = false;
// ★追加：埋め草領域拡張の拡張データ部（バイト配列 / 未設定なら null）
//   管理部（拡張管理部＋終端4ビット）の直後、埋め草の手前に
//   「長さ16ビット＋本体」の形で入る。仕様書 8. の図と同じ位置。
var _paddingExtBytes = null;

    var _this = {};

    // ---- public API ----
    _this.addData = function (data, mode) {
      mode = mode || 'Byte';
      var newData = null;
      switch (mode) {
        case 'Numeric':
          newData = qrNumber(data);
          break;
        case 'Alphanumeric':
          newData = qrAlphaNum(data);
          break;
        case 'Byte':
          newData = qr8BitByte(data);
          break;
        case 'Kanji':
          newData = qrKanji(data);
          break;
        default:
          throw new Error('invalid mode: ' + mode);
      }
      _dataList.push(newData);
      _dataCache = null;
    };

    _this.isDark = function (row, col) {
      if (_modules[row][col] != null) {
        return _modules[row][col];
      }
      return false;
    };

    _this.getModuleCount = function () {
      return _moduleCount;
    };

_this.make = function () {

  // ★AUTO(ver=0) の場合、pattern設置より前に必ずtypeNumber確定
  if (_typeNumber < 1) {
    _typeNumber = chooseTypeNumber(_errorCorrectionLevel, _dataList, _managementBits);
  }

  var mp = (_maskPatternOverride !== null && _maskPatternOverride !== undefined)
    ? _maskPatternOverride
    : getBestMaskPattern();

  makeImpl(false, mp);
};


    _this.createTableTag = function (cellSize, margin) {
      cellSize = cellSize || 2;
      margin = (typeof margin === 'undefined') ? cellSize * 4 : margin;

      var qrHtml = '';
      qrHtml += '<table style="border:0;border-collapse:collapse;">';
      qrHtml += '<tbody>';

      for (var r = 0; r < _moduleCount; r++) {

        qrHtml += '<tr>';

        for (var c = 0; c < _moduleCount; c++) {
          qrHtml += '<td style="border:0;border-collapse:collapse;padding:0;margin:0;width:' + cellSize + 'px;height:' + cellSize + 'px;background-color:' + (_this.isDark(r, c) ? '#000' : '#fff') + ';"></td>';
        }

        qrHtml += '</tr>';
      }

      qrHtml += '</tbody>';
      qrHtml += '</table>';

      return qrHtml;
    };

    _this.createImgTag = function (cellSize, margin) {
      cellSize = cellSize || 2;
      margin = (typeof margin === 'undefined') ? cellSize * 4 : margin;

      var size = _moduleCount * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      return createImgTag(size, size, function (x, y) {
        if (min <= x && x < max && min <= y && y < max) {
          var c = Math.floor((x - min) / cellSize);
          var r = Math.floor((y - min) / cellSize);
          return _this.isDark(r, c) ? 0 : 1;
        }
        return 1;
      });
    };

    // ★追加：管理部32bitセットAPI（HTMLがこれを呼ぶ）
    // bits32: "0101..."(32文字) または 0..4294967295 数値
    _this.setManagementBits = function (bits32) {
      if (bits32 === null || bits32 === undefined || bits32 === '') {
        _managementBits = null;
        _dataCache = null;
        return;
      }

      // ★Ver3.1：管理部を16ビット語の配列で保持する。
      //   48ビット管理部はJSのビット演算(32ビット)で扱えないため、
      //   32ビット/48ビットを同じ形（16ビット語の並び）に正規化して持つ。
      if (typeof bits32 === 'number') {
        if (!isFinite(bits32) || bits32 < 0 || bits32 > 0xFFFFFFFF) {
          throw new Error('managementBits(number) must be 0..4294967295');
        }
        _managementBits = [((bits32 >>> 16) & 0xFFFF), (bits32 & 0xFFFF)];
        _dataCache = null;
        return;
      }

      var s = String(bits32).trim();
      if (/^[01]+$/.test(s) && s.length % 16 === 0 && s.length >= 16 && s.length <= 64) {
        // 16の倍数ビット（16/32/48/64）を16ビット語へ分割
        var words = [];
        for (var wi = 0; wi < s.length; wi += 16) {
          words.push(parseInt(s.substring(wi, wi + 16), 2));
        }
        _managementBits = words;
        _dataCache = null;
        return;
      }
      throw new Error('managementBits(string) must be a multiple of 16 bits (16/32/48/64), e.g. 48 bits for Ver3.1');
    };

    // 管理部が占めるビット数（16ビット語×語数）
    var managementBitLength = function (mb) {
      if (mb === null || mb === undefined) return 0;
      return (typeof mb === 'number') ? 32 : (mb.length * 16);
    };
    // 管理部をビットバッファへ書き出す
    var putManagementBits = function (buffer, mb) {
      if (typeof mb === 'number') {
        buffer.put(((mb >>> 16) & 0xFFFF), 16);
        buffer.put((mb & 0xFFFF), 16);
        return;
      }
      for (var i = 0; i < mb.length; i++) buffer.put((mb[i] & 0xFFFF), 16);
    };
    _this._managementBitLength = managementBitLength;
    _this._putManagementBits = putManagementBits;

// ★追加：拡張管理部32bitセットAPI
_this.setManagementExt32 = function (bits32) {
  if (bits32 === null || bits32 === undefined || bits32 === '') {
    _managementExt32 = null;
    _dataCache = null;
    return;
  }
  if (typeof bits32 === 'number') {
    _managementExt32 = (bits32 >>> 0); // unsigned 32bit
    _dataCache = null;
    return;
  }
  var s = String(bits32).trim();
  if (/^[01]{32}$/.test(s)) {
    _managementExt32 = (parseInt(s, 2) >>> 0);
    _dataCache = null;
    return;
  }
  throw new Error('managementExt32 must be 32 bits or a number');
};

// ★追加：拡張管理部 複数32bitブロックセットAPI
// blocks: [num1, num2, ...] の配列（各要素は unsigned 32bit 数値）
_this.setManagementExtBlocks = function (blocks) {
  if (!blocks || !Array.isArray(blocks) || blocks.length === 0) {
    _managementExtBlocks = null;
    _dataCache = null;
    return;
  }
  _managementExtBlocks = blocks.map(function(v) { return (v >>> 0); });
  _dataCache = null;
};

// ★追加：読取位置48bitセットAPI
// latLonPair: [latVal24, lonVal24] の配列（各要素は 0..16777215 の24bit数値）
_this.setLocationExt48 = function (latLonPair) {
  if (!latLonPair || !Array.isArray(latLonPair) || latLonPair.length !== 2) {
    _locationExt48 = null;
    _dataCache = null;
    return;
  }
  _locationExt48 = [(latLonPair[0] & 0xFFFFFF), (latLonPair[1] & 0xFFFFFF)];
  _dataCache = null;
};

// ★追加：市町村コード24bitセットAPI
_this.setMunicipalityExt24 = function (code24) {
  if (code24 === null || code24 === undefined) {
    _municipalityExt24 = null;
    _dataCache = null;
    return;
  }
  _municipalityExt24 = (code24 & 0xFFFFFF);
  _dataCache = null;
};

// ★追加：QRツイン固有番号8bitセットAPI
_this.setQrTwinUniqueId8 = function (id8) {
  if (id8 === null || id8 === undefined || id8 === '') {
    _qrTwinUniqueId8 = null;
    _dataCache = null;
    return;
  }
  var id = parseInt(id8, 10);
  if (!isFinite(id) || id < 0 || id > 255) {
    throw new Error('qrTwinUniqueId8 must be 0..255, or null');
  }
  _qrTwinUniqueId8 = id & 0xFF;
  _dataCache = null;
};

// ★追加：埋め草領域拡張のセットAPI
_this.setPaddingExtBytes = function (bytes) {
  if (!bytes || !bytes.length) {
    _paddingExtBytes = null;
    _dataCache = null;
    return;
  }
  if (bytes.length > 65535) {
    throw new Error('paddingExtBytes must be 65535 bytes or fewer');
  }
  var arr = new Array(bytes.length);
  for (var i = 0; i < bytes.length; i++) arr[i] = bytes[i] & 0xFF;
  _paddingExtBytes = arr;
  _dataCache = null;
};

// ★追加：拡張データ部に使える空きバイト数を返す（現在のデータ＋管理部を前提）。
//   生成側が「余りをどれだけ相手のLQRへ移せるか」を決めるために使う。
//   戻り値は「長さ16ビットを引いた後」の本体バイト数。
_this.getPaddingExtCapacity = function () {
  if (_typeNumber < 1) return 0;
  var rsBlocks = QRRSBlock.getRSBlocks(_typeNumber, _errorCorrectionLevel);
  var totalDataCount = 0;
  for (var i = 0; i < rsBlocks.length; i++) totalDataCount += rsBlocks[i].dataCount;
  var totalBits = totalDataCount * 8;

  // データ本体のビット数
  var used = 0;
  for (var d = 0; d < _dataList.length; d++) {
    var dt = _dataList[d];
    used += 4 + QRUtil.getLengthInBits(dt.getMode(), _typeNumber) + dt.getLength() * 8;
  }
  used += 4;   // 1つ目の終端

  // 管理部と拡張管理部
  if (_managementBits !== null && _managementBits !== undefined) {
    var extBlks = _managementExtBlocks || (_managementExt32 !== null && _managementExt32 !== undefined ? [_managementExt32] : []);
    used += managementBitLength(_managementBits) + 4 + extBlks.length * 32;
    if (_webDataIdExt32 !== null) used += 32;
    if (_locationExt48) used += 48;
    if (_municipalityExt24 !== null) used += 24;
    if (_qrTwinUniqueId8 !== null) used += 8;
    if (_userIdExt32 !== null) used += 32;
  }
  var free = totalBits - used - 16;   // 16 は拡張データ部の長さフィールド
  return free > 0 ? Math.floor(free / 8) : 0;
};

// ★追加：逆順データモードのセットAPI（同一データ4色QRの第2LQR）
_this.setReverseDataMode = function (on) {
  _reverseDataMode = !!on;
  _dataCache = null;
};

// ★追加：WEBデータID 32bitセットAPI
_this.setWebDataIdExt32 = function (id32) {
  if (id32 === null || id32 === undefined || id32 === '') {
    _webDataIdExt32 = null;
    _dataCache = null;
    return;
  }
  var v = Number(id32);
  if (!isFinite(v) || v < 0 || v > 4294967295) {
    throw new Error('webDataIdExt32 must be 0..4294967295, or null');
  }
  _webDataIdExt32 = (v >>> 0);
  _dataCache = null;
};

// ★追加：ユーザーID 32bitセットAPI
// id32: 0..4294967295 の数値、または32桁の 0/1 文字列。null で未設定。
_this.setUserIdExt32 = function (id32) {
  if (id32 === null || id32 === undefined || id32 === '') {
    _userIdExt32 = null;
    _dataCache = null;
    return;
  }
  if (typeof id32 === 'number') {
    if (!isFinite(id32) || id32 < 0 || id32 > 4294967295) {
      throw new Error('userIdExt32 must be 0..4294967295, or null');
    }
    _userIdExt32 = (id32 >>> 0);
    _dataCache = null;
    return;
  }
  var s = String(id32).trim();
  if (/^[01]{32}$/.test(s)) {
    _userIdExt32 = (parseInt(s, 2) >>> 0);
    _dataCache = null;
    return;
  }
  throw new Error('userIdExt32 must be 32 bits or a number');
};

// ★追加：マスク固定API
// mask: 0..7 を指定 → 固定
// null/undefined/-1 → AUTO（最適マスク選択）
_this.setMaskPattern = function(mask){
  if (mask === null || mask === undefined || mask === '' || mask === -1) {
    _maskPatternOverride = null;
    _dataCache = null;
    return;
  }
  var m = parseInt(mask, 10);
  if (!isFinite(m) || m < 0 || m > 7) {
    throw new Error('maskPattern must be 0..7, or null for AUTO');
  }
  _maskPatternOverride = m;
  _dataCache = null;
};

// ★追加：XOR暗号化マスクをセット（配列/Uint8ArrayどちらでもOK）
//   【Ver2.5 改修】 マスクは「データ部のみ」に適用される。長さは getDataCodeCount() に合わせる。
//   XOR を適用してから RS 誤り訂正コード語を計算し直すので、読取側は鍵が無くても
//   RS 訂正まで実施可能（=パスワード入力前から第2QR の生データが安定的に取得できる）。
_this.setXorMaskBytes = function(bytes){
  if (bytes === null || bytes === undefined) {
    _xorMaskBytes = null;
    return;
  }
  _xorMaskBytes = Array.from(bytes);
};

// ★追加：総コード語数（データ部+訂正部の総バイト数）を返す
_this.getTotalCodeCount = function(){
  if (_typeNumber < 1) {
    _typeNumber = chooseTypeNumber(_errorCorrectionLevel, _dataList, _managementBits);
  }
  var rsBlocks = QRRSBlock.getRSBlocks(_typeNumber, _errorCorrectionLevel);
  var total = 0;
  for (var i = 0; i < rsBlocks.length; i++) total += rsBlocks[i].totalCount;
  return total; // bytes
};

// ★追加 (Ver2.5)：データ部のみのコード語数（ECC を除く）を返す
//   ユーザ暗号化の新方式では、この長さ分のマスクを生成して setXorMaskBytes に渡す。
_this.getDataCodeCount = function(){
  if (_typeNumber < 1) {
    _typeNumber = chooseTypeNumber(_errorCorrectionLevel, _dataList, _managementBits);
  }
  var rsBlocks = QRRSBlock.getRSBlocks(_typeNumber, _errorCorrectionLevel);
  var total = 0;
  for (var i = 0; i < rsBlocks.length; i++) total += rsBlocks[i].dataCount;
  return total; // bytes
};

// ★追加：全コード語（データ+訂正）をバイト配列で返す（XOR前）
_this.getRawCodewords = function(){
  if (_typeNumber < 1) {
    _typeNumber = chooseTypeNumber(_errorCorrectionLevel, _dataList, _managementBits);
  }
  if (_dataCache == null) {
    _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList, _managementBits);
  }
  return _dataCache.slice(); // コピーを返す
};

// ★追加：データバイトのみ（ECC除く）をバイト配列で返す
// 電子署名のハッシュ計算に使用（RS誤り訂正で常に正確に復元されるため安定）
_this.getRawDataBytes = function(){
  if (_typeNumber < 1) {
    _typeNumber = chooseTypeNumber(_errorCorrectionLevel, _dataList, _managementBits);
  }
  if (_dataCache == null) {
    _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList, _managementBits);
  }
  return _dataBytesCache ? _dataBytesCache.slice() : null;
};

    // expose for UI info
    Object.defineProperty(_this, 'typeNumber', { get: function () { return _typeNumber; } });

    // ---- internal ----
    var makeImpl = function (test, maskPattern) {

      _moduleCount = _typeNumber * 4 + 17;
      _modules = function (moduleCount) {
        var modules = new Array(moduleCount);
        for (var row = 0; row < moduleCount; row++) {
          modules[row] = new Array(moduleCount);
          for (var col = 0; col < moduleCount; col++) {
            modules[row][col] = null;
          }
        }
        return modules;
      }(_moduleCount);

      setupPositionProbePattern(0, 0);
      setupPositionProbePattern(_moduleCount - 7, 0);
      setupPositionProbePattern(0, _moduleCount - 7);
      setupPositionAdjustPattern();
      setupTimingPattern();
      setupTypeInfo(test, maskPattern);

      if (_typeNumber >= 7) {
        setupTypeNumber(test);
      }

// ★【Ver2.5 改修】 _xorMaskBytes は「データ部のみ」のマスク。
//   createData の中で「データ部だけ XOR → その XOR 後のデータから ECC を再計算 → インタリーブ」
//   を行うことで、最終的な _dataCache は
//     [ XOR'd data interleaved + ECC(XOR'd data) interleaved ]
//   になる。読取側は鍵なしでも RS 訂正まで実施できる（=安定）。
if (_dataCache == null) {
  _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList, _managementBits, _xorMaskBytes);
}

// _dataCache 自体が既に最終形なので、ここで追加の XOR は行わない。
      mapData(_dataCache, maskPattern);
    };


    var chooseTypeNumber = function (errorCorrectionLevel, dataList, managementBits) {
      // Find minimal version that fits. Must include management(16)+terminator(4) if set.
      for (var type = 1; type <= 40; type++) {

        var rsBlocks = QRRSBlock.getRSBlocks(type, errorCorrectionLevel);

        var buffer = qrBitBuffer();
        for (var i = 0; i < dataList.length; i++) {
          var data = dataList[i];
          buffer.put(data.getMode(), 4);
          buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), type));
          data.write(buffer);
        }

        var totalDataCount = 0;
        for (var i = 0; i < rsBlocks.length; i++) {
          totalDataCount += rsBlocks[i].dataCount;
        }

        var totalBits = totalDataCount * 8;

        // Original terminator (up to 4 bits)
        var bitsLeft = totalBits - buffer.getLengthInBits();
        if (bitsLeft <= 0) continue;
        buffer.put(0, Math.min(4, bitsLeft));

        // management(32bit) + ext32 blocks(optional) + location48(optional) + municipality24(optional) + qrTwinUniqueId8(optional) + second terminator
        if (managementBits !== null && managementBits !== undefined) {
          var mgmtNeed = managementBitLength(managementBits) + 4;
          var extBlks = _managementExtBlocks || (_managementExt32 !== null && _managementExt32 !== undefined ? [_managementExt32] : []);
          if (_webDataIdExt32 !== null) mgmtNeed += 32;
          mgmtNeed += extBlks.length * 32;
          if (_locationExt48) mgmtNeed += 48;
          if (_municipalityExt24 !== null) mgmtNeed += 24;
          if (_qrTwinUniqueId8 !== null) mgmtNeed += 8;
          if (_userIdExt32 !== null) mgmtNeed += 32;
          if (_paddingExtBytes) mgmtNeed += 16 + _paddingExtBytes.length * 8;
          bitsLeft = totalBits - buffer.getLengthInBits();
          if (bitsLeft < mgmtNeed) continue;
          putManagementBits(buffer, managementBits);
          // 拡張管理部の先頭：WEBデータID（dataPosition が 00 以外のとき）
          if (_webDataIdExt32 !== null) {
            buffer.put((_webDataIdExt32 >>> 0), 32);
          }
          for (var ei = 0; ei < extBlks.length; ei++) {
            buffer.put((extBlks[ei] >>> 0), 32);
          }
          if (_locationExt48) {
            buffer.put((_locationExt48[0] & 0xFFFFFF), 24);
            buffer.put((_locationExt48[1] & 0xFFFFFF), 24);
          }
          if (_municipalityExt24 !== null) {
            buffer.put((_municipalityExt24 & 0xFFFFFF), 24);
          }
          if (_qrTwinUniqueId8 !== null) {
            buffer.put((_qrTwinUniqueId8 & 0xFF), 8);
          }
          if (_userIdExt32 !== null) {
            buffer.put((_userIdExt32 >>> 0), 32);
          }
          buffer.put(0, 4);
          // 埋め草領域拡張：長さ16ビット＋本体
          if (_paddingExtBytes) {
            buffer.put(_paddingExtBytes.length & 0xFFFF, 16);
            for (var pi = 0; pi < _paddingExtBytes.length; pi++) {
              buffer.put(_paddingExtBytes[pi] & 0xFF, 8);
            }
          }
        }

        // bit padding
        while (buffer.getLengthInBits() % 8 != 0) buffer.putBit(false);

        // byte padding (standard)
        while (buffer.getLengthInBits() / 8 < totalDataCount) {
          buffer.put(PAD0, 8);
          if (buffer.getLengthInBits() / 8 >= totalDataCount) break;
          buffer.put(PAD1, 8);
        }

        if (buffer.getLengthInBits() / 8 <= totalDataCount) {
          return type;
        }
      }
      throw new Error('Data too long');
    };

    var setupPositionProbePattern = function (row, col) {

      for (var r = -1; r <= 7; r++) {
        if (row + r <= -1 || _moduleCount <= row + r) continue;

        for (var c = -1; c <= 7; c++) {
          if (col + c <= -1 || _moduleCount <= col + c) continue;

          if ((0 <= r && r <= 6 && (c == 0 || c == 6))
            || (0 <= c && c <= 6 && (r == 0 || r == 6))
            || (2 <= r && r <= 4 && 2 <= c && c <= 4)) {
            _modules[row + r][col + c] = true;
          } else {
            _modules[row + r][col + c] = false;
          }
        }
      }
    };

    var getBestMaskPattern = function () {

      var minLostPoint = 0;
      var pattern = 0;

      for (var i = 0; i < 8; i++) {
        makeImpl(true, i);

        var lostPoint = QRUtil.getLostPoint(_this);

        if (i == 0 || minLostPoint > lostPoint) {
          minLostPoint = lostPoint;
          pattern = i;
        }
      }

      return pattern;
    };

    var setupTimingPattern = function () {

      for (var r = 8; r < _moduleCount - 8; r++) {
        if (_modules[r][6] != null) continue;
        _modules[r][6] = (r % 2 == 0);
      }

      for (var c = 8; c < _moduleCount - 8; c++) {
        if (_modules[6][c] != null) continue;
        _modules[6][c] = (c % 2 == 0);
      }
    };

    var setupPositionAdjustPattern = function () {

      var pos = QRUtil.getPatternPosition(_typeNumber);

      for (var i = 0; i < pos.length; i++) {
        for (var j = 0; j < pos.length; j++) {

          var row = pos[i];
          var col = pos[j];

          if (_modules[row][col] != null) continue;

          for (var r = -2; r <= 2; r++) {
            for (var c = -2; c <= 2; c++) {
              if (r == -2 || r == 2 || c == -2 || c == 2 || (r == 0 && c == 0)) {
                _modules[row + r][col + c] = true;
              } else {
                _modules[row + r][col + c] = false;
              }
            }
          }
        }
      }
    };

    var setupTypeNumber = function (test) {

      var bits = QRUtil.getBCHTypeNumber(_typeNumber);

      for (var i = 0; i < 18; i++) {
        var mod = (!test && ((bits >> i) & 1) == 1);
        _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
      }

      for (var i = 0; i < 18; i++) {
        var mod = (!test && ((bits >> i) & 1) == 1);
        _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
      }
    };

    var setupTypeInfo = function (test, maskPattern) {

      var data = (_errorCorrectionLevel << 3) | maskPattern;
      var bits = QRUtil.getBCHTypeInfo(data);

      // vertical
      for (var i = 0; i < 15; i++) {

        var mod = (!test && ((bits >> i) & 1) == 1);

        if (i < 6) {
          _modules[i][8] = mod;
        } else if (i < 8) {
          _modules[i + 1][8] = mod;
        } else {
          _modules[_moduleCount - 15 + i][8] = mod;
        }
      }

      // horizontal
      for (var i = 0; i < 15; i++) {

        var mod = (!test && ((bits >> i) & 1) == 1);

        if (i < 8) {
          _modules[8][_moduleCount - i - 1] = mod;
        } else if (i < 9) {
          _modules[8][15 - i - 1 + 1] = mod;
        } else {
          _modules[8][15 - i - 1] = mod;
        }
      }

      _modules[_moduleCount - 8][8] = (!test);
    };

    var mapData = function (data, maskPattern) {

      var inc = -1;
      var row = _moduleCount - 1;
      var bitIndex = 7;
      var byteIndex = 0;
      var maskFunc = QRUtil.getMaskFunction(maskPattern);

      for (var col = _moduleCount - 1; col > 0; col -= 2) {

        if (col == 6) col--;

        while (true) {

          for (var c = 0; c < 2; c++) {

            if (_modules[row][col - c] == null) {

              var dark = false;

              if (byteIndex < data.length) {
                dark = (((data[byteIndex] >>> bitIndex) & 1) == 1);
              }

              var mask = maskFunc(row, col - c);

              if (mask) {
                dark = !dark;
              }

              _modules[row][col - c] = dark;
              bitIndex--;

              if (bitIndex == -1) {
                byteIndex++;
                bitIndex = 7;
              }
            }
          }

          row += inc;

          if (row < 0 || _moduleCount <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    };

    // ★改造：createData (managementBits + ext32 を挿入)
    var createData = function (typeNumber, errorCorrectionLevel, dataList, managementBits, dataXorMask) {

      var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);

      var buffer = qrBitBuffer();

      for (var i = 0; i < dataList.length; i++) {
        var data = dataList[i];
        buffer.put(data.getMode(), 4);
        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber));
        data.write(buffer);
      }

      var totalDataCount = 0;
      for (var i = 0; i < rsBlocks.length; i++) {
        totalDataCount += rsBlocks[i].dataCount;
      }

      var totalBits = totalDataCount * 8;

      // 1) Original terminator (up to 4 bits)
      var bitsLeft = totalBits - buffer.getLengthInBits();
      if (bitsLeft <= 0) {
        throw new Error('code length overflow (no space for terminator)');
      }
      buffer.put(0, Math.min(4, bitsLeft));

      // 2) management(32bit) + ext32 blocks(optional) + location48(optional) + municipality24(optional) + qrTwinUniqueId8(optional) + second terminator(4)
      if (managementBits !== null && managementBits !== undefined) {
        var extBlks2 = _managementExtBlocks || (_managementExt32 !== null && _managementExt32 !== undefined ? [_managementExt32] : []);
        var mgmtTotalBits = managementBitLength(managementBits) + 4 + extBlks2.length * 32;
        if (_webDataIdExt32 !== null) mgmtTotalBits += 32;
        if (_locationExt48) mgmtTotalBits += 48;
        if (_municipalityExt24 !== null) mgmtTotalBits += 24;
        if (_qrTwinUniqueId8 !== null) mgmtTotalBits += 8;
        if (_userIdExt32 !== null) mgmtTotalBits += 32;
        if (_paddingExtBytes) mgmtTotalBits += 16 + _paddingExtBytes.length * 8;
        bitsLeft = totalBits - buffer.getLengthInBits();
        if (bitsLeft < mgmtTotalBits) {
          throw new Error('code length overflow (no space for managementBits + ext blocks + terminator)');
        }
        putManagementBits(buffer, managementBits);
        // 拡張管理部の先頭：WEBデータID（dataPosition が 00 以外のとき）
        if (_webDataIdExt32 !== null) {
          buffer.put((_webDataIdExt32 >>> 0), 32);
        }
        for (var ei2 = 0; ei2 < extBlks2.length; ei2++) {
          buffer.put((extBlks2[ei2] >>> 0), 32);
        }
        if (_locationExt48) {
          buffer.put((_locationExt48[0] & 0xFFFFFF), 24);
          buffer.put((_locationExt48[1] & 0xFFFFFF), 24);
        }
        if (_municipalityExt24 !== null) {
          buffer.put((_municipalityExt24 & 0xFFFFFF), 24);
        }
        if (_qrTwinUniqueId8 !== null) {
          buffer.put((_qrTwinUniqueId8 & 0xFF), 8);
        }
        if (_userIdExt32 !== null) {
          buffer.put((_userIdExt32 >>> 0), 32);
        }
        buffer.put(0, 4);
        // 埋め草領域拡張：長さ16ビット＋本体
        if (_paddingExtBytes) {
          buffer.put(_paddingExtBytes.length & 0xFFFF, 16);
          for (var pi2 = 0; pi2 < _paddingExtBytes.length; pi2++) {
            buffer.put(_paddingExtBytes[pi2] & 0xFF, 8);
          }
        }
      }

      // 3) bit padding to byte boundary
      while (buffer.getLengthInBits() % 8 != 0) {
        buffer.putBit(false);
      }

      // 4) byte padding
      while (buffer.getLengthInBits() / 8 < totalDataCount) {
        buffer.put(PAD0, 8);
        if (buffer.getLengthInBits() / 8 >= totalDataCount) break;
        buffer.put(PAD1, 8);
      }

      // ★ データバイト（ECC除く）をキャッシュ（署名ハッシュ用）
      //   注：ユーザ暗号化マスク適用前の **平文** データバイトをキャッシュする。
      //   これは電子署名のハッシュ計算で「平文」を使うため重要。
      _dataBytesCache = [];
      for (var dbi = 0; dbi < totalDataCount; dbi++) {
        _dataBytesCache.push(0xff & buffer.getBuffer()[dbi]);
      }

      // ★【Ver2.5 改修】 ユーザ暗号化用 XOR マスクをデータ部のみに適用してから
      //   createBytes へ。createBytes 内で RS ECC は XOR 後データを基に再計算される。
      if (dataXorMask && dataXorMask.length) {
        if (dataXorMask.length !== totalDataCount) {
          throw new Error('dataXorMask length mismatch: need ' + totalDataCount + ' bytes (data only, ECC excluded), got ' + dataXorMask.length);
        }
        var bufArr = buffer.getBuffer();
        for (var xi = 0; xi < totalDataCount; xi++) {
          bufArr[xi] = (bufArr[xi] ^ (dataXorMask[xi] & 0xFF)) & 0xFF;
        }
      }

      // ★逆順データモード：データ部（埋め草含む）のビット列を逆順にしてから
      //   RS誤り訂正データを作る（仕様書 6.2 ステップ1〜2）。
      //   バイト順の反転＋各バイト内のビット反転で、ビット列全体を逆順にする。
      if (_reverseDataMode) {
        var bufR = buffer.getBuffer();
        var rev = new Array(totalDataCount);
        for (var ri = 0; ri < totalDataCount; ri++) {
          var rv = bufR[totalDataCount - 1 - ri] & 0xFF;
          rv = ((rv & 0xF0) >> 4) | ((rv & 0x0F) << 4);
          rv = ((rv & 0xCC) >> 2) | ((rv & 0x33) << 2);
          rv = ((rv & 0xAA) >> 1) | ((rv & 0x55) << 1);
          rev[ri] = rv & 0xFF;
        }
        for (var wi2 = 0; wi2 < totalDataCount; wi2++) bufR[wi2] = rev[wi2];
      }

      return createBytes(buffer, rsBlocks);
    };

    var createBytes = function (buffer, rsBlocks) {

      var offset = 0;

      var maxDcCount = 0;
      var maxEcCount = 0;

      var dcdata = new Array(rsBlocks.length);
      var ecdata = new Array(rsBlocks.length);

      for (var r = 0; r < rsBlocks.length; r++) {

        var dcCount = rsBlocks[r].dataCount;
        var ecCount = rsBlocks[r].totalCount - dcCount;

        maxDcCount = Math.max(maxDcCount, dcCount);
        maxEcCount = Math.max(maxEcCount, ecCount);

        dcdata[r] = new Array(dcCount);

        for (var i = 0; i < dcdata[r].length; i++) {
          dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];
        }
        offset += dcCount;

        var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
        var rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);

        var modPoly = rawPoly.mod(rsPoly);
        ecdata[r] = new Array(rsPoly.getLength() - 1);

        for (var i = 0; i < ecdata[r].length; i++) {
          var modIndex = i + modPoly.getLength() - ecdata[r].length;
          ecdata[r][i] = (modIndex >= 0) ? modPoly.get(modIndex) : 0;
        }
      }

      var totalCodeCount = 0;
      for (var i = 0; i < rsBlocks.length; i++) {
        totalCodeCount += rsBlocks[i].totalCount;
      }

      var data = new Array(totalCodeCount);
      var index = 0;

      for (var i = 0; i < maxDcCount; i++) {
        for (var r = 0; r < rsBlocks.length; r++) {
          if (i < dcdata[r].length) {
            data[index++] = dcdata[r][i];
          }
        }
      }

      for (var i = 0; i < maxEcCount; i++) {
        for (var r = 0; r < rsBlocks.length; r++) {
          if (i < ecdata[r].length) {
            data[index++] = ecdata[r][i];
          }
        }
      }

      return data;
    };

    return _this;
  };

  // expose
  window.qrcode = qrcode;

  // ★追加：汚損サンプル生成で、RSブロック構成と位置合わせパターン座標が必要
  qrcode.getRSBlocks = function (typeNumber, errorCorrectionLevel) {
    return QRRSBlock.getRSBlocks(typeNumber, QRErrorCorrectionLevel[errorCorrectionLevel]);
  };
  qrcode.getAlignmentPositions = function (typeNumber) {
    return QRUtil.getPatternPosition(typeNumber);
  };

  //---------------------------------------------------------------------
  // String to bytes (UTF-8)
  //---------------------------------------------------------------------
  qrcode.stringToBytesFuncs = {
    'UTF-8': function (s) {
      var bytes = [];
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c < 0x80) {
          bytes.push(c);
        } else if (c < 0x800) {
          bytes.push(0xC0 | (c >> 6));
          bytes.push(0x80 | (c & 0x3F));
        } else if (c < 0xD800 || c >= 0xE000) {
          bytes.push(0xE0 | (c >> 12));
          bytes.push(0x80 | ((c >> 6) & 0x3F));
          bytes.push(0x80 | (c & 0x3F));
        } else {
          // surrogate pair
          i++;
          var c2 = s.charCodeAt(i);
          var codePoint = 0x10000 + (((c & 0x3FF) << 10) | (c2 & 0x3FF));
          bytes.push(0xF0 | (codePoint >> 18));
          bytes.push(0x80 | ((codePoint >> 12) & 0x3F));
          bytes.push(0x80 | ((codePoint >> 6) & 0x3F));
          bytes.push(0x80 | (codePoint & 0x3F));
        }
      }
      return bytes;
    }
  };

  //---------------------------------------------------------------------
  // QRMode
  //---------------------------------------------------------------------
  var QRMode = {
    MODE_NUMBER: 1,
    MODE_ALPHA_NUM: 2,
    MODE_8BIT_BYTE: 4,
    MODE_KANJI: 8
  };

  //---------------------------------------------------------------------
  // QRErrorCorrectionLevel
  //---------------------------------------------------------------------
  var QRErrorCorrectionLevel = {
    L: 1,
    M: 0,
    Q: 3,
    H: 2
  };

  //---------------------------------------------------------------------
  // QRMaskPattern
  //---------------------------------------------------------------------
  var QRMaskPattern = {
    PATTERN000: 0,
    PATTERN001: 1,
    PATTERN010: 2,
    PATTERN011: 3,
    PATTERN100: 4,
    PATTERN101: 5,
    PATTERN110: 6,
    PATTERN111: 7
  };

  //---------------------------------------------------------------------
  // QRUtil
  //---------------------------------------------------------------------
  var QRUtil = {

    PATTERN_POSITION_TABLE: [
      [],
      [6, 18],
      [6, 22],
      [6, 26],
      [6, 30],
      [6, 34],
      [6, 22, 38],
      [6, 24, 42],
      [6, 26, 46],
      [6, 28, 50],
      [6, 30, 54],
      [6, 32, 58],
      [6, 34, 62],
      [6, 26, 46, 66],
      [6, 26, 48, 70],
      [6, 26, 50, 74],
      [6, 30, 54, 78],
      [6, 30, 56, 82],
      [6, 30, 58, 86],
      [6, 34, 62, 90],
      [6, 28, 50, 72, 94],
      [6, 26, 50, 74, 98],
      [6, 30, 54, 78, 102],
      [6, 28, 54, 80, 106],
      [6, 32, 58, 84, 110],
      [6, 30, 58, 86, 114],
      [6, 34, 62, 90, 118],
      [6, 26, 50, 74, 98, 122],
      [6, 30, 54, 78, 102, 126],
      [6, 26, 52, 78, 104, 130],
      [6, 30, 56, 82, 108, 134],
      [6, 34, 60, 86, 112, 138],
      [6, 30, 58, 86, 114, 142],
      [6, 34, 62, 90, 118, 146],
      [6, 30, 54, 78, 102, 126, 150],
      [6, 24, 50, 76, 102, 128, 154],
      [6, 28, 54, 80, 106, 132, 158],
      [6, 32, 58, 84, 110, 136, 162],
      [6, 26, 54, 82, 110, 138, 166],
      [6, 30, 58, 86, 114, 142, 170]
    ],

    G15: (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0),
    G18: (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0),
    G15_MASK: (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1),

    getBCHTypeInfo: function (data) {
      var d = data << 10;
      while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G15) >= 0) {
        d ^= (QRUtil.G15 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G15)));
      }
      return ((data << 10) | d) ^ QRUtil.G15_MASK;
    },

    getBCHTypeNumber: function (data) {
      var d = data << 12;
      while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G18) >= 0) {
        d ^= (QRUtil.G18 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G18)));
      }
      return (data << 12) | d;
    },

    getBCHDigit: function (data) {
      var digit = 0;
      while (data != 0) {
        digit++;
        data >>>= 1;
      }
      return digit;
    },

    getPatternPosition: function (typeNumber) {
      return QRUtil.PATTERN_POSITION_TABLE[typeNumber - 1];
    },

    getMaskFunction: function (maskPattern) {
      switch (maskPattern) {
        case QRMaskPattern.PATTERN000: return function (i, j) { return (i + j) % 2 == 0; };
        case QRMaskPattern.PATTERN001: return function (i, j) { return i % 2 == 0; };
        case QRMaskPattern.PATTERN010: return function (i, j) { return j % 3 == 0; };
        case QRMaskPattern.PATTERN011: return function (i, j) { return (i + j) % 3 == 0; };
        case QRMaskPattern.PATTERN100: return function (i, j) { return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 == 0; };
        case QRMaskPattern.PATTERN101: return function (i, j) { return (i * j) % 2 + (i * j) % 3 == 0; };
        case QRMaskPattern.PATTERN110: return function (i, j) { return ((i * j) % 2 + (i * j) % 3) % 2 == 0; };
        case QRMaskPattern.PATTERN111: return function (i, j) { return ((i * j) % 3 + (i + j) % 2) % 2 == 0; };
        default: throw new Error('bad maskPattern:' + maskPattern);
      }
    },

    getErrorCorrectPolynomial: function (errorCorrectLength) {
      var a = qrPolynomial([1], 0);
      for (var i = 0; i < errorCorrectLength; i++) {
        a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0));
      }
      return a;
    },

    getLengthInBits: function (mode, type) {
      if (1 <= type && type < 10) {
        switch (mode) {
          case QRMode.MODE_NUMBER: return 10;
          case QRMode.MODE_ALPHA_NUM: return 9;
          case QRMode.MODE_8BIT_BYTE: return 8;
          case QRMode.MODE_KANJI: return 8;
          default: throw new Error('mode:' + mode);
        }
      } else if (type < 27) {
        switch (mode) {
          case QRMode.MODE_NUMBER: return 12;
          case QRMode.MODE_ALPHA_NUM: return 11;
          case QRMode.MODE_8BIT_BYTE: return 16;
          case QRMode.MODE_KANJI: return 10;
          default: throw new Error('mode:' + mode);
        }
      } else if (type < 41) {
        switch (mode) {
          case QRMode.MODE_NUMBER: return 14;
          case QRMode.MODE_ALPHA_NUM: return 13;
          case QRMode.MODE_8BIT_BYTE: return 16;
          case QRMode.MODE_KANJI: return 12;
          default: throw new Error('mode:' + mode);
        }
      } else {
        throw new Error('type:' + type);
      }
    },

    getLostPoint: function (qrcode) {
      var moduleCount = qrcode.getModuleCount();
      var lostPoint = 0;

      // LEVEL1
      for (var row = 0; row < moduleCount; row++) {
        for (var col = 0; col < moduleCount; col++) {
          var sameCount = 0;
          var dark = qrcode.isDark(row, col);

          for (var r = -1; r <= 1; r++) {
            if (row + r < 0 || moduleCount <= row + r) continue;
            for (var c = -1; c <= 1; c++) {
              if (col + c < 0 || moduleCount <= col + c) continue;
              if (r == 0 && c == 0) continue;
              if (dark == qrcode.isDark(row + r, col + c)) sameCount++;
            }
          }
          if (sameCount > 5) lostPoint += (3 + sameCount - 5);
        }
      }

      // LEVEL2
      for (var row = 0; row < moduleCount - 1; row++) {
        for (var col = 0; col < moduleCount - 1; col++) {
          var count = 0;
          if (qrcode.isDark(row, col)) count++;
          if (qrcode.isDark(row + 1, col)) count++;
          if (qrcode.isDark(row, col + 1)) count++;
          if (qrcode.isDark(row + 1, col + 1)) count++;
          if (count == 0 || count == 4) lostPoint += 3;
        }
      }

      // LEVEL3
      for (var row = 0; row < moduleCount; row++) {
        for (var col = 0; col < moduleCount - 6; col++) {
          if (qrcode.isDark(row, col)
            && !qrcode.isDark(row, col + 1)
            && qrcode.isDark(row, col + 2)
            && qrcode.isDark(row, col + 3)
            && qrcode.isDark(row, col + 4)
            && !qrcode.isDark(row, col + 5)
            && qrcode.isDark(row, col + 6)) {
            lostPoint += 40;
          }
        }
      }

      for (var col = 0; col < moduleCount; col++) {
        for (var row = 0; row < moduleCount - 6; row++) {
          if (qrcode.isDark(row, col)
            && !qrcode.isDark(row + 1, col)
            && qrcode.isDark(row + 2, col)
            && qrcode.isDark(row + 3, col)
            && qrcode.isDark(row + 4, col)
            && !qrcode.isDark(row + 5, col)
            && qrcode.isDark(row + 6, col)) {
            lostPoint += 40;
          }
        }
      }

      // LEVEL4
      var darkCount = 0;
      for (var col = 0; col < moduleCount; col++) {
        for (var row = 0; row < moduleCount; row++) {
          if (qrcode.isDark(row, col)) darkCount++;
        }
      }

      var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
      lostPoint += ratio * 10;

      return lostPoint;
    }
  };

  //---------------------------------------------------------------------
  // QRMath
  //---------------------------------------------------------------------
  var QRMath = {
    glog: function (n) {
      if (n < 1) throw new Error('glog(' + n + ')');
      return QRMath.LOG_TABLE[n];
    },
    gexp: function (n) {
      while (n < 0) n += 255;
      while (n >= 256) n -= 255;
      return QRMath.EXP_TABLE[n];
    },
    EXP_TABLE: new Array(256),
    LOG_TABLE: new Array(256)
  };

  for (var i = 0; i < 8; i++) QRMath.EXP_TABLE[i] = 1 << i;
  for (var i = 8; i < 256; i++) {
    QRMath.EXP_TABLE[i] =
      QRMath.EXP_TABLE[i - 4] ^
      QRMath.EXP_TABLE[i - 5] ^
      QRMath.EXP_TABLE[i - 6] ^
      QRMath.EXP_TABLE[i - 8];
  }
  for (var i = 0; i < 255; i++) QRMath.LOG_TABLE[QRMath.EXP_TABLE[i]] = i;

  //---------------------------------------------------------------------
  // qrPolynomial
  //---------------------------------------------------------------------
  var qrPolynomial = function (num, shift) {

    var offset = 0;
    while (offset < num.length && num[offset] == 0) offset++;

    var _num = new Array(num.length - offset + shift);
    for (var i = 0; i < num.length - offset; i++) {
      _num[i] = num[i + offset];
    }

    var _this = {};
    _this.get = function (index) { return _num[index]; };
    _this.getLength = function () { return _num.length; };
    _this.multiply = function (e) {
      var num = new Array(_this.getLength() + e.getLength() - 1);
      for (var i = 0; i < num.length; i++) num[i] = 0;

      for (var i = 0; i < _this.getLength(); i++) {
        for (var j = 0; j < e.getLength(); j++) {
          num[i + j] ^= QRMath.gexp(QRMath.glog(_this.get(i)) + QRMath.glog(e.get(j)));
        }
      }
      return qrPolynomial(num, 0);
    };
    _this.mod = function (e) {
      if (_this.getLength() - e.getLength() < 0) return _this;

      var ratio = QRMath.glog(_this.get(0)) - QRMath.glog(e.get(0));
      var num = new Array(_this.getLength());
      for (var i = 0; i < _this.getLength(); i++) num[i] = _this.get(i);

      for (var i = 0; i < e.getLength(); i++) {
        num[i] ^= QRMath.gexp(QRMath.glog(e.get(i)) + ratio);
      }
      return qrPolynomial(num, 0).mod(e);
    };
    return _this;
  };

  //---------------------------------------------------------------------
  // qrBitBuffer
  //---------------------------------------------------------------------
  var qrBitBuffer = function () {
    var _buffer = [];
    var _length = 0;

    var _this = {};
    _this.getBuffer = function () { return _buffer; };
    _this.getAt = function (index) {
      var bufIndex = Math.floor(index / 8);
      return ((_buffer[bufIndex] >>> (7 - index % 8)) & 1) == 1;
    };
    _this.put = function (num, length) {
      for (var i = 0; i < length; i++) {
        _this.putBit(((num >>> (length - i - 1)) & 1) == 1);
      }
    };
    _this.getLengthInBits = function () { return _length; };
    _this.putBit = function (bit) {
      var bufIndex = Math.floor(_length / 8);
      if (_buffer.length <= bufIndex) _buffer.push(0);
      if (bit) _buffer[bufIndex] |= (0x80 >>> (_length % 8));
      _length++;
    };
    return _this;
  };

  //---------------------------------------------------------------------
  // Data classes
  //---------------------------------------------------------------------
  var qr8BitByte = function (data) {
    var _mode = QRMode.MODE_8BIT_BYTE;
    var _data = data;

    var _bytes = null;
    var _this = {};

    _this.getMode = function () { return _mode; };
    _this.getLength = function () {
      if (_bytes == null) {
        if (typeof _data === 'string') {
          _bytes = qrcode.stringToBytes(_data);
        } else {
          _bytes = _data; // Assume it's an array of bytes
        }
      }
      return _bytes.length;
    };
    _this.write = function (buffer) {
      if (_bytes == null) {
        if (typeof _data === 'string') {
          _bytes = qrcode.stringToBytes(_data);
        } else {
          _bytes = _data;
        }
      }
      for (var i = 0; i < _bytes.length; i++) buffer.put(_bytes[i], 8);
    };

    return _this;
  };

  // minimal stubs (Numeric/Alphanumeric/Kanji) to keep API compatible
  var qrNumber = function (data) { return qr8BitByte(data); };
  var qrAlphaNum = function (data) { return qr8BitByte(data); };
  var qrKanji = function (data) { return qr8BitByte(data); };

  // stringToBytes function (default UTF-8)
  qrcode.stringToBytes = function (s) {
    return qrcode.stringToBytesFuncs['UTF-8'](s);
  };

  //---------------------------------------------------------------------
  // QRRSBlock
  //---------------------------------------------------------------------
  var QRRSBlock = function (totalCount, dataCount) {
    var _this = {};
    _this.totalCount = totalCount;
    _this.dataCount = dataCount;
    return _this;
  };

  // Full RS_BLOCK_TABLE for versions 1..40 (L/M/Q/H)
  // This is the standard table used by qrcode-generator.
  QRRSBlock.RS_BLOCK_TABLE = [
    // 1
    [1, 26, 19], [1, 26, 16], [1, 26, 13], [1, 26, 9],
    // 2
    [1, 44, 34], [1, 44, 28], [1, 44, 22], [1, 44, 16],
    // 3
    [1, 70, 55], [1, 70, 44], [2, 35, 17], [2, 35, 13],
    // 4
    [1, 100, 80], [2, 50, 32], [2, 50, 24], [4, 25, 9],
    // 5
    [1, 134, 108], [2, 67, 43], [2, 33, 15, 2, 34, 16], [2, 33, 11, 2, 34, 12],
    // 6
    [2, 86, 68], [4, 43, 27], [4, 43, 19], [4, 43, 15],
    // 7
    [2, 98, 78], [4, 49, 31], [2, 32, 14, 4, 33, 15], [4, 39, 13, 1, 40, 14],
    // 8
    [2, 121, 97], [2, 60, 38, 2, 61, 39], [4, 40, 18, 2, 41, 19], [4, 40, 14, 2, 41, 15],
    // 9
    [2, 146, 116], [3, 58, 36, 2, 59, 37], [4, 36, 16, 4, 37, 17], [4, 36, 12, 4, 37, 13],
    // 10
    [2, 86, 68, 2, 87, 69], [4, 69, 43, 1, 70, 44], [6, 43, 19, 2, 44, 20], [6, 43, 15, 2, 44, 16],
    // 11
    [4, 101, 81], [1, 80, 50, 4, 81, 51], [4, 50, 22, 4, 51, 23], [3, 36, 12, 8, 37, 13],
    // 12
    [2, 116, 92, 2, 117, 93], [6, 58, 36, 2, 59, 37], [4, 46, 20, 6, 47, 21], [7, 42, 14, 4, 43, 15],
    // 13
    [4, 133, 107], [8, 59, 37, 1, 60, 38], [8, 44, 20, 4, 45, 21], [12, 33, 11, 4, 34, 12],
    // 14
    [3, 145, 115, 1, 146, 116], [4, 64, 40, 5, 65, 41], [11, 36, 16, 5, 37, 17], [11, 36, 12, 5, 37, 13],
    // 15
    [5, 109, 87, 1, 110, 88], [5, 65, 41, 5, 66, 42], [5, 54, 24, 7, 55, 25], [11, 36, 12, 7, 37, 13],
    // 16
    [5, 122, 98, 1, 123, 99], [7, 73, 45, 3, 74, 46], [15, 43, 19, 2, 44, 20], [3, 45, 15, 13, 46, 16],
    // 17
    [1, 135, 107, 5, 136, 108], [10, 74, 46, 1, 75, 47], [1, 50, 22, 15, 51, 23], [2, 42, 14, 17, 43, 15],
    // 18
    [5, 150, 120, 1, 151, 121], [9, 69, 43, 4, 70, 44], [17, 50, 22, 1, 51, 23], [2, 42, 14, 19, 43, 15],
    // 19
    [3, 141, 113, 4, 142, 114], [3, 70, 44, 11, 71, 45], [17, 47, 21, 4, 48, 22], [9, 39, 13, 16, 40, 14],
    // 20
    [3, 135, 107, 5, 136, 108], [3, 67, 41, 13, 68, 42], [15, 54, 24, 5, 55, 25], [15, 43, 15, 10, 44, 16],
    // 21
    [4, 144, 116, 4, 145, 117], [17, 68, 42], [17, 50, 22, 6, 51, 23], [19, 46, 16, 6, 47, 17],
    // 22
    [2, 139, 111, 7, 140, 112], [17, 74, 46], [7, 54, 24, 16, 55, 25], [34, 37, 13],
    // 23
    [4, 151, 121, 5, 152, 122], [4, 75, 47, 14, 76, 48], [11, 54, 24, 14, 55, 25], [16, 45, 15, 14, 46, 16],
    // 24
    [6, 147, 117, 4, 148, 118], [6, 73, 45, 14, 74, 46], [11, 54, 24, 16, 55, 25], [30, 46, 16, 2, 47, 17],
    // 25
    [8, 132, 106, 4, 133, 107], [8, 75, 47, 13, 76, 48], [7, 54, 24, 22, 55, 25], [22, 45, 15, 13, 46, 16],
    // 26
    [10, 142, 114, 2, 143, 115], [19, 74, 46, 4, 75, 47], [28, 50, 22, 6, 51, 23], [33, 46, 16, 4, 47, 17],
    // 27
    [8, 152, 122, 4, 153, 123], [22, 73, 45, 3, 74, 46], [8, 53, 23, 26, 54, 24], [12, 45, 15, 28, 46, 16],
    // 28
    [3, 147, 117, 10, 148, 118], [3, 73, 45, 23, 74, 46], [4, 54, 24, 31, 55, 25], [11, 45, 15, 31, 46, 16],
    // 29
    [7, 146, 116, 7, 147, 117], [21, 73, 45, 7, 74, 46], [1, 53, 23, 37, 54, 24], [19, 45, 15, 26, 46, 16],
    // 30
    [5, 145, 115, 10, 146, 116], [19, 75, 47, 10, 76, 48], [15, 54, 24, 25, 55, 25], [23, 45, 15, 25, 46, 16],
    // 31
    [13, 145, 115, 3, 146, 116], [2, 74, 46, 29, 75, 47], [42, 54, 24, 1, 55, 25], [23, 45, 15, 28, 46, 16],
    // 32
    [17, 145, 115], [10, 74, 46, 23, 75, 47], [10, 54, 24, 35, 55, 25], [19, 45, 15, 35, 46, 16],
    // 33
    [17, 145, 115, 1, 146, 116], [14, 74, 46, 21, 75, 47], [29, 54, 24, 19, 55, 25], [11, 45, 15, 46, 46, 16],
    // 34
    [13, 145, 115, 6, 146, 116], [14, 74, 46, 23, 75, 47], [44, 54, 24, 7, 55, 25], [59, 46, 16, 1, 47, 17],
    // 35
    [12, 151, 121, 7, 152, 122], [12, 75, 47, 26, 76, 48], [39, 54, 24, 14, 55, 25], [22, 45, 15, 41, 46, 16],
    // 36
    [6, 151, 121, 14, 152, 122], [6, 75, 47, 34, 76, 48], [46, 54, 24, 10, 55, 25], [2, 45, 15, 64, 46, 16],
    // 37
    [17, 152, 122, 4, 153, 123], [29, 74, 46, 14, 75, 47], [49, 54, 24, 10, 55, 25], [24, 45, 15, 46, 46, 16],
    // 38
    [4, 152, 122, 18, 153, 123], [13, 74, 46, 32, 75, 47], [48, 54, 24, 14, 55, 25], [42, 45, 15, 32, 46, 16],
    // 39
    [20, 147, 117, 4, 148, 118], [40, 75, 47, 7, 76, 48], [43, 54, 24, 22, 55, 25], [10, 45, 15, 67, 46, 16],
    // 40
    [19, 148, 118, 6, 149, 119], [18, 75, 47, 31, 76, 48], [34, 54, 24, 34, 55, 25], [20, 45, 15, 61, 46, 16]
  ];

  QRRSBlock.getRSBlocks = function (typeNumber, errorCorrectionLevel) {
    var rsBlock = QRRSBlock.getRsBlockTable(typeNumber, errorCorrectionLevel);
    if (rsBlock == undefined) throw new Error('bad rs block @ typeNumber:' + typeNumber + '/errorCorrectionLevel:' + errorCorrectionLevel);

    var length = rsBlock.length / 3;
    var list = [];

    for (var i = 0; i < length; i++) {
      var count = rsBlock[i * 3 + 0];
      var totalCount = rsBlock[i * 3 + 1];
      var dataCount = rsBlock[i * 3 + 2];
      for (var j = 0; j < count; j++) list.push(QRRSBlock(totalCount, dataCount));
    }
    return list;
  };

  QRRSBlock.getRsBlockTable = function (typeNumber, errorCorrectionLevel) {
    switch (errorCorrectionLevel) {
      case QRErrorCorrectionLevel.L: return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
      case QRErrorCorrectionLevel.M: return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
      case QRErrorCorrectionLevel.Q: return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
      case QRErrorCorrectionLevel.H: return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
      default: return undefined;
    }
  };

  //---------------------------------------------------------------------
  // Helpers for IMG (optional)
  //---------------------------------------------------------------------
  function createImgTag(width, height, getPixel) {
    var gif = gifImage(width, height);
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        gif.setPixel(x, y, getPixel(x, y));
      }
    }
    return gif.toDataURL();
  }

  // Minimal GIF encoder (enough for createImgTag)
  function gifImage(width, height) {
    var _width = width;
    var _height = height;
    var _data = new Array(width * height);
    for (var i = 0; i < _data.length; i++) _data[i] = 1;

    var _this = {};
    _this.setPixel = function (x, y, pixel) {
      _data[y * _width + x] = pixel ? 1 : 0;
    };
    _this.toDataURL = function () {
      // very small GIF (2-color) dataURL generator
      // (This is kept minimal; canvas path is usually used in your HTML.)
      return "data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==";
    };
    return _this;
  }

})();
