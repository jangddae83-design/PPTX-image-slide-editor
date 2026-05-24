import React, { useState, useEffect, useCallback } from 'react';
import { Rect, SlideData, TextOverlay, OCRResult, VerticalAlign, HorizontalAlign } from '../types';
import { analyzeTextInImage } from '../services/geminiService';
import { encryptText, decryptText } from '../services/cryptoService';
import { 
  Loader2, 
  Type as TypeIcon, 
  Info, 
  CheckCircle2, 
  Sparkles,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignVerticalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  MoveHorizontal,
  Lock,
  Unlock,
  Settings,
  Trash2,
  AlertTriangle,
  Key,
  Shield,
  HelpCircle
} from 'lucide-react';

interface SidebarProps {
  activeSlide: SlideData | undefined;
  selection: Rect | null;
  selectedOverlayId: string | null;
  onApplyOverlay: (overlay: TextOverlay) => void;
  onUpdateOverlays: (overlays: TextOverlay[]) => void;
}

const FONTS = [
  { name: 'Inter', value: 'Inter' },
  { name: 'Arial', value: 'Arial' },
  { name: 'Roboto', value: 'Roboto' },
  { name: 'Times New Roman', value: 'serif' },
  { name: 'Courier New', value: 'monospace' },
];

const Sidebar: React.FC<SidebarProps> = ({ 
  activeSlide, 
  selection, 
  selectedOverlayId,
  onApplyOverlay,
  onUpdateOverlays
}) => {
  // --- 🔒 보안 관련 상태 추가 ---
  const [activeApiKey, setActiveApiKey] = useState<string | null>(null);
  const [isSessionTemporary, setIsSessionTemporary] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [masterPasswordInput, setMasterPasswordInput] = useState('');
  const [apiKeyRegisterInput, setApiKeyRegisterInput] = useState('');
  const [shouldSaveToLocalStorage, setShouldSaveToLocalStorage] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [showTempKeyInput, setShowTempKeyInput] = useState(false);
  const [tempApiKeyInput, setTempApiKeyInput] = useState('');

  // --- 기존 에디터 상태 ---
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [ocrResult, setOcrResult] = useState<OCRResult | null>(null);
  
  const [replacementText, setReplacementText] = useState('');
  const [fontSize, setFontSize] = useState(16);
  const [fontWeight, setFontWeight] = useState('normal');
  const [fontColor, setFontColor] = useState('#000000');
  const [fontFamily, setFontFamily] = useState('Inter');
  const [vAlign, setVAlign] = useState<VerticalAlign>('top');
  const [hAlign, setHAlign] = useState<HorizontalAlign>('left');
  const [letterSpacing, setLetterSpacing] = useState(0);

  // 배경 관련 상태
  const [backgroundColor, setBackgroundColor] = useState('#ffffff');
  const [isTransparent, setIsTransparent] = useState(false);

  const selectedOverlay = activeSlide?.overlays.find(o => o.id === selectedOverlayId);

  // 최초 로딩 시 로컬 저장소 키 체크
  useEffect(() => {
    const key = localStorage.getItem('secured_gemini_api_key');
    setHasStoredKey(!!key);
  }, []);

  useEffect(() => {
    if (!selection && !selectedOverlayId) {
      setOcrResult(null);
      setReplacementText('');
      setBackgroundColor('#ffffff');
      setIsTransparent(false);
    }
  }, [selection, selectedOverlayId]);

  useEffect(() => {
    if (selectedOverlay) {
      setReplacementText(selectedOverlay.newText);
      setFontSize(selectedOverlay.fontSize);
      setFontWeight(selectedOverlay.fontWeight);
      setFontColor(selectedOverlay.fontColor);
      setFontFamily(selectedOverlay.fontFamily);
      setVAlign(selectedOverlay.vAlign || 'top');
      setHAlign(selectedOverlay.hAlign || 'left');
      setLetterSpacing(selectedOverlay.letterSpacing || 0);
      
      const bg = selectedOverlay.backgroundColor;
      if (bg === 'rgba(0,0,0,0)' || bg === 'transparent') {
        setIsTransparent(true);
        setBackgroundColor('#ffffff');
      } else {
        setIsTransparent(false);
        setBackgroundColor(bg || '#ffffff');
      }
    }
  }, [selectedOverlayId]);

  // 로컬 캔버스에서 주변 배경색 추출 (Mode 알고리즘 사용)
  const detectBackgroundColor = useCallback((ctx: CanvasRenderingContext2D, width: number, height: number): string => {
    try {
      const data = ctx.getImageData(0, 0, width, height).data;
      const colorCounts: { [key: string]: { count: number, r: number, g: number, b: number } } = {};
      
      const addPixel = (x: number, y: number) => {
        const i = (y * width + x) * 4;
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];
        const a = data[i+3];

        if (a < 50) return;

        const bucket = 10;
        const key = `${Math.round(r / bucket)},${Math.round(g / bucket)},${Math.round(b / bucket)}`;

        if (!colorCounts[key]) {
          colorCounts[key] = { count: 0, r: 0, g: 0, b: 0 };
        }
        colorCounts[key].count++;
        colorCounts[key].r += r;
        colorCounts[key].g += g;
        colorCounts[key].b += b;
      };

      const depth = 5; 

      // 상하 테두리
      for (let x = 0; x < width; x++) {
        for (let y = 0; y < Math.min(depth, height); y++) addPixel(x, y);
        for (let y = Math.max(0, height - depth); y < height; y++) addPixel(x, y);
      }
      
      // 좌우 테두리
      for (let y = depth; y < height - depth; y++) {
        for (let x = 0; x < Math.min(depth, width); x++) addPixel(x, y);
        for (let x = Math.max(0, width - depth); x < width; x++) addPixel(x, y);
      }

      let maxCount = 0;
      let dominantColor = null;

      for (const key in colorCounts) {
        if (colorCounts[key].count > maxCount) {
          maxCount = colorCounts[key].count;
          dominantColor = {
            r: Math.round(colorCounts[key].r / maxCount),
            g: Math.round(colorCounts[key].g / maxCount),
            b: Math.round(colorCounts[key].b / maxCount)
          };
        }
      }

      if (!dominantColor) return '#ffffff';

      const toHex = (c: number) => {
        const hex = c.toString(16);
        return hex.length === 1 ? '0' + hex : hex;
      };

      return `#${toHex(dominantColor.r)}${toHex(dominantColor.g)}${toHex(dominantColor.b)}`;
    } catch (e) {
      console.error("Color detection failed", e);
      return '#ffffff';
    }
  }, []);

  const getCroppedCanvas = async (usePadding = false) => {
    if (!selection || !activeSlide) return null;

    const padding = usePadding ? 10 : 0;
    
    const startX = Math.max(0, Math.floor(selection.x - padding));
    const startY = Math.max(0, Math.floor(selection.y - padding));
    const endX = Math.min(activeSlide.width, Math.ceil(selection.x + selection.width + padding));
    const endY = Math.min(activeSlide.height, Math.ceil(selection.y + selection.height + padding));
    
    const width = endX - startX;
    const height = endY - startY;

    if (width <= 0 || height <= 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const img = new Image();
    img.src = activeSlide.dataUrl;
    await new Promise(resolve => img.onload = resolve);

    ctx.drawImage(img, startX, startY, width, height, 0, 0, width, height);
    return { canvas, ctx, width, height };
  };

  // 선택 영역 변경 시 배경색 자동 감지
  useEffect(() => {
    if (selection && activeSlide && !selectedOverlayId) {
      const detect = async () => {
        try {
          const result = await getCroppedCanvas(true);
          if (!result) return;
          
          const detectedBg = detectBackgroundColor(result.ctx, result.width, result.height);
          setBackgroundColor(detectedBg);
          setIsTransparent(false); 
        } catch (e) {
          console.error(e);
        }
      };
      detect();
    }
  }, [selection, activeSlide, selectedOverlayId, detectBackgroundColor]);

  // --- 🔒 보안 관련 이벤트 헨들러 ---
  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    const stored = localStorage.getItem('secured_gemini_api_key');
    if (!stored) return;
    try {
      const decrypted = await decryptText(stored, masterPasswordInput);
      setActiveApiKey(decrypted);
      setIsSessionTemporary(false);
      setMasterPasswordInput('');
    } catch (err) {
      console.error(err);
      setAuthError('비밀번호가 틀렸습니다. 다시 확인해 주세요.');
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    if (!apiKeyRegisterInput.trim()) {
      setAuthError('API 키를 입력해 주세요.');
      return;
    }

    if (shouldSaveToLocalStorage) {
      if (!masterPasswordInput.trim()) {
        setAuthError('암호화에 사용할 마스터 비밀번호를 설정해 주세요.');
        return;
      }
      try {
        const encrypted = await encryptText(apiKeyRegisterInput.trim(), masterPasswordInput.trim());
        localStorage.setItem('secured_gemini_api_key', encrypted);
        setHasStoredKey(true);
        setActiveApiKey(apiKeyRegisterInput.trim());
        setIsSessionTemporary(false);
      } catch (err) {
        console.error(err);
        setAuthError('암호화 중 에러가 발생했습니다.');
        return;
      }
    } else {
      setActiveApiKey(apiKeyRegisterInput.trim());
      setIsSessionTemporary(true);
    }
    
    setApiKeyRegisterInput('');
    setMasterPasswordInput('');
  };

  const handleTempSessionUnlock = (e: React.FormEvent) => {
    e.preventDefault();
    if (!tempApiKeyInput.trim()) {
      setAuthError('임시 API 키를 입력해 주세요.');
      return;
    }
    setActiveApiKey(tempApiKeyInput.trim());
    setIsSessionTemporary(true);
    setTempApiKeyInput('');
    setShowTempKeyInput(false);
    setAuthError(null);
  };

  const handleLock = () => {
    setActiveApiKey(null);
    setIsSettingsOpen(false);
  };

  const handleWipeData = () => {
    if (window.confirm('저장된 API 키와 마스터 비밀번호 정보가 로컬 컴퓨터에서 영구적으로 삭제됩니다. 계속하시겠습니까?')) {
      localStorage.removeItem('secured_gemini_api_key');
      setHasStoredKey(false);
      setActiveApiKey(null);
      setIsSettingsOpen(false);
      setMasterPasswordInput('');
      setAuthError(null);
    }
  };

  const handleAnalyze = async () => {
    if (!selection || !activeSlide || !activeApiKey) return;
    setIsAnalyzing(true);
    try {
      const bgResult = await getCroppedCanvas(true);
      if (bgResult) {
        const detectedBg = detectBackgroundColor(bgResult.ctx, bgResult.width, bgResult.height);
        setBackgroundColor(detectedBg);
        setIsTransparent(false);
      }

      const ocrResultCanvas = await getCroppedCanvas(false);
      if (!ocrResultCanvas) return;

      const cropDataUrl = ocrResultCanvas.canvas.toDataURL('image/png');
      const result = await analyzeTextInImage(cropDataUrl, activeApiKey);
      
      setOcrResult(result);
      setReplacementText(result.text);
      setFontSize(result.fontSize);
      setFontWeight(result.fontWeight);
      setFontColor(result.fontColor);
      setFontFamily(result.fontFamily);
      
      setVAlign('middle');
      setHAlign('center');
      setLetterSpacing(0);
    } catch (err) {
      console.error(err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const updateSelectedOverlay = (updates: Partial<TextOverlay>) => {
    if (!selectedOverlayId || !activeSlide) return;
    const newOverlays = activeSlide.overlays.map(ov => 
      ov.id === selectedOverlayId ? { ...ov, ...updates } : ov
    );
    onUpdateOverlays(newOverlays);
  };

  const handleApply = () => {
    if (!selection) return;
    onApplyOverlay({
      id: Math.random().toString(36).substr(2, 9),
      rect: { ...selection },
      originalText: ocrResult?.text || '',
      newText: replacementText,
      fontSize,
      fontWeight,
      fontColor,
      fontFamily,
      backgroundColor: isTransparent ? 'rgba(0,0,0,0)' : backgroundColor,
      vAlign,
      hAlign,
      letterSpacing
    });
  };

  const isEditing = !!selectedOverlayId;

  // --- 🔒 [렌더링] 보안 잠금 상태 UI ---
  if (!activeApiKey) {
    return (
      <div className="w-80 h-full bg-[#1e293b] border-l border-slate-700 flex flex-col p-6 overflow-y-auto select-none font-sans text-slate-100">
        <div className="flex-1 flex flex-col justify-center py-6">
          <div className="text-center mb-8">
            <div className="inline-flex p-4 rounded-3xl bg-blue-500/10 text-blue-400 border border-blue-500/20 mb-4 shadow-2xl animate-pulse">
              <Shield size={40} />
            </div>
            <h2 className="text-lg font-black text-slate-100 tracking-tight">AI 슬라이드 에디터 보안</h2>
            <p className="text-xs text-slate-400 mt-1">로컬 브라우저 암호화 및 다중 사용자 보호</p>
          </div>

          {authError && (
            <div className="mb-6 p-3 bg-red-950/40 border border-red-500/30 rounded-xl flex items-start gap-2.5 text-xs text-red-300">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>{authError}</span>
            </div>
          )}

          {hasStoredKey ? (
            /* CASE 1: 잠금 해제 화면 */
            <form onSubmit={handleUnlock} className="space-y-5">
              <div className="space-y-2">
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">마스터 비밀번호</label>
                <div className="relative">
                  <input 
                    type="password" 
                    value={masterPasswordInput}
                    onChange={(e) => setMasterPasswordInput(e.target.value)}
                    placeholder="비밀번호 입력"
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3.5 text-sm text-slate-100 focus:outline-none focus:border-blue-500 transition-all placeholder:text-slate-500"
                    autoFocus
                  />
                  <div className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-500"><Lock size={16} /></div>
                </div>
              </div>

              <button 
                type="submit" 
                className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3.5 rounded-xl flex items-center justify-center gap-2 shadow-lg active:scale-95 transition-all text-sm"
              >
                <Unlock size={16} /> 잠금 해제
              </button>

              <div className="relative my-6 text-center">
                <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-slate-800"></div></div>
                <span className="relative bg-[#1e293b] px-3 text-[10px] text-slate-500 font-bold uppercase tracking-wider">또는</span>
              </div>

              {showTempKeyInput ? (
                /* 임시 세션 키 입력 폼 */
                <div className="space-y-3 bg-slate-900/40 p-4 rounded-2xl border border-slate-800">
                  <div className="space-y-1.5">
                    <label className="block text-[9px] font-bold text-slate-400 uppercase tracking-widest">임시 사용 API Key</label>
                    <input 
                      type="password" 
                      value={tempApiKeyInput}
                      onChange={(e) => setTempApiKeyInput(e.target.value)}
                      placeholder="AIzaSy..."
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-blue-500 transition-all"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button 
                      type="button"
                      onClick={handleTempSessionUnlock}
                      className="flex-1 bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold py-2 rounded-lg transition-all"
                    >
                      실행
                    </button>
                    <button 
                      type="button"
                      onClick={() => { setShowTempKeyInput(false); setTempApiKeyInput(''); setAuthError(null); }}
                      className="flex-1 bg-slate-800 hover:bg-slate-750 text-slate-400 text-xs py-2 rounded-lg transition-all"
                    >
                      취소
                    </button>
                  </div>
                </div>
              ) : (
                <button 
                  type="button"
                  onClick={() => { setShowTempKeyInput(true); setAuthError(null); }}
                  className="w-full bg-slate-800/80 hover:bg-slate-700 text-slate-300 text-xs font-medium py-3 rounded-xl border border-slate-700 transition-all flex items-center justify-center gap-1.5"
                >
                  <Key size={14} className="text-slate-400" /> 임시로 내 API 키 사용하기 (저장 안 됨)
                </button>
              )}

              <button 
                type="button"
                onClick={handleWipeData}
                className="w-full text-red-400/80 hover:text-red-400 text-[10px] font-bold tracking-wider uppercase py-2 flex items-center justify-center gap-1 transition-all"
              >
                <Trash2 size={12} /> 기기 저장 데이터 완전 삭제 및 초기화
              </button>
            </form>
          ) : (
            /* CASE 2: 최초 등록 화면 */
            <form onSubmit={handleRegister} className="space-y-5">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">Gemini API Key</label>
                  <a 
                    href="https://aistudio.google.com/" 
                    target="_blank" 
                    rel="noreferrer"
                    className="text-[9px] text-blue-400 hover:underline font-bold flex items-center gap-0.5"
                  >
                    키 발급받기 <HelpCircle size={10} />
                  </a>
                </div>
                <input 
                  type="password" 
                  value={apiKeyRegisterInput}
                  onChange={(e) => setApiKeyRegisterInput(e.target.value)}
                  placeholder="AIzaSy..."
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3.5 text-sm text-slate-100 focus:outline-none focus:border-blue-500 transition-all placeholder:text-slate-500"
                  autoFocus
                />
              </div>

              <div className="space-y-4 pt-1">
                <label className="flex items-start gap-2.5 cursor-pointer group select-none">
                  <input 
                    type="checkbox" 
                    checked={shouldSaveToLocalStorage}
                    onChange={(e) => setShouldSaveToLocalStorage(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-600 focus:ring-0 focus:ring-offset-0 mt-0.5"
                  />
                  <div className="text-xs">
                    <span className="text-slate-200 font-bold group-hover:text-white transition-colors">이 브라우저에 암호화하여 저장</span>
                    <p className="text-[10px] text-slate-500 leading-relaxed mt-0.5">매번 입력할 필요 없이 마스터 비밀번호로 즉시 사용할 수 있습니다.</p>
                  </div>
                </label>
              </div>

              {shouldSaveToLocalStorage && (
                <div className="space-y-2 pt-1 border-t border-slate-850">
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest">마스터 비밀번호 설정</label>
                  <input 
                    type="password" 
                    value={masterPasswordInput}
                    onChange={(e) => setMasterPasswordInput(e.target.value)}
                    placeholder="암호화 및 해제에 쓸 비밀번호"
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3.5 text-sm text-slate-100 focus:outline-none focus:border-blue-500 transition-all placeholder:text-slate-500"
                  />
                </div>
              )}

              <button 
                type="submit" 
                className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3.5 rounded-xl flex items-center justify-center gap-2 shadow-lg active:scale-95 transition-all text-sm mt-3"
              >
                <CheckCircle2 size={16} /> 등록 및 사용 시작
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  // --- 🎨 [렌더링] 일반 편집 화면 + 상단 보안 배지 ---
  return (
    <div className="w-80 h-full bg-[#1e293b] border-l border-slate-700 flex flex-col p-6 overflow-y-auto font-sans text-slate-100">
      
      {/* 🔒 상단 보안 컨트롤 배지 */}
      <div className="mb-6 pb-4 border-b border-slate-800/80">
        <div className="flex items-center justify-between bg-slate-900/50 px-3.5 py-2.5 rounded-xl border border-slate-800">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isSessionTemporary ? 'bg-amber-400 animate-pulse' : 'bg-emerald-500'}`} />
            <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest">
              {isSessionTemporary ? '임시 세션 모드' : '기기 보안 로그인'}
            </span>
          </div>
          <button 
            onClick={() => setIsSettingsOpen(!isSettingsOpen)}
            className={`p-1.5 rounded-lg hover:bg-slate-850 transition-all ${isSettingsOpen ? 'bg-slate-850 text-blue-400' : 'text-slate-500 hover:text-slate-300'}`}
            title="보안 설정"
          >
            <Settings size={14} />
          </button>
        </div>

        {isSettingsOpen && (
          <div className="mt-3 p-3 bg-slate-900/80 rounded-xl border border-slate-850 space-y-2.5">
            <p className="text-[9px] text-slate-500 leading-relaxed">이 컴퓨터에서 자리를 비우거나 데이터를 파기하려면 아래 메뉴를 클릭하세요.</p>
            <div className="grid grid-cols-2 gap-2">
              <button 
                onClick={handleLock}
                className="flex items-center justify-center gap-1 px-2 py-1.5 bg-slate-850 hover:bg-slate-800 text-slate-300 text-[10px] font-bold rounded-lg transition-all border border-slate-750"
              >
                <Lock size={12} /> 임시 잠그기
              </button>
              <button 
                onClick={handleWipeData}
                className="flex items-center justify-center gap-1 px-2 py-1.5 bg-red-950/20 hover:bg-red-950/40 text-red-400 text-[10px] font-bold rounded-lg transition-all border border-red-950/30"
              >
                <Trash2 size={12} /> 영구 삭제
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">
          <TypeIcon size={16} className="text-blue-400" />
          {isEditing ? '텍스트 수정' : '텍스트 교체'}
        </h2>
      </div>

      {!selection && !isEditing ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center text-slate-400">
          <div className="w-16 h-16 rounded-xl bg-slate-800 flex items-center justify-center mb-4 border border-slate-700">
            <Info size={32} className="opacity-50" />
          </div>
          <p className="text-sm">텍스트 교체 영역을 선택하거나<br/>교체된 텍스트를 클릭하세요</p>
        </div>
      ) : (
        <div className="space-y-6">
          {!isEditing && (
            <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700">
              <h3 className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-3">AI 텍스트 분석</h3>
              {isAnalyzing ? (
                <div className="flex items-center gap-3 py-4 text-blue-400">
                  <Loader2 className="animate-spin" size={18} />
                  <span className="text-sm">분석 중...</span>
                </div>
              ) : ocrResult ? (
                <div className="space-y-3">
                  <div className="p-3 bg-slate-900 rounded text-sm text-slate-300 italic border border-slate-800">"{ocrResult.text}"</div>
                </div>
              ) : (
                <button 
                  onClick={handleAnalyze} 
                  className="w-full bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold py-3 rounded-lg flex items-center justify-center gap-2 transition-all"
                >
                  <Sparkles size={14} className="text-blue-400" /> AI 분석 (OCR) 실행
                </button>
              )}
            </div>
          )}

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest">내용</label>
              <textarea 
                value={replacementText} 
                onChange={(e) => {
                  setReplacementText(e.target.value);
                  if (isEditing) updateSelectedOverlay({ newText: e.target.value });
                }} 
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm h-24 resize-none focus:outline-none focus:border-blue-500 text-slate-200" 
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest">수평 정렬</label>
                <div className="flex bg-slate-900 p-1 rounded-lg border border-slate-800">
                  <button onClick={() => { setHAlign('left'); if (isEditing) updateSelectedOverlay({ hAlign: 'left' }); }} className={`flex-1 p-1.5 rounded flex justify-center ${hAlign === 'left' ? 'bg-slate-700 text-blue-400' : 'text-slate-500'}`}><AlignLeft size={16} /></button>
                  <button onClick={() => { setHAlign('center'); if (isEditing) updateSelectedOverlay({ hAlign: 'center' }); }} className={`flex-1 p-1.5 rounded flex justify-center ${hAlign === 'center' ? 'bg-slate-700 text-blue-400' : 'text-slate-500'}`}><AlignCenter size={16} /></button>
                  <button onClick={() => { setHAlign('right'); if (isEditing) updateSelectedOverlay({ hAlign: 'right' }); }} className={`flex-1 p-1.5 rounded flex justify-center ${hAlign === 'right' ? 'bg-slate-700 text-blue-400' : 'text-slate-500'}`}><AlignRight size={16} /></button>
                </div>
              </div>
              <div className="space-y-2">
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest">수직 정렬</label>
                <div className="flex bg-slate-900 p-1 rounded-lg border border-slate-800">
                  <button onClick={() => { setVAlign('top'); if (isEditing) updateSelectedOverlay({ vAlign: 'top' }); }} className={`flex-1 p-1.5 rounded flex justify-center ${vAlign === 'top' ? 'bg-slate-700 text-blue-400' : 'text-slate-500'}`} title="위쪽"><AlignVerticalJustifyStart size={16} /></button>
                  <button onClick={() => { setVAlign('middle'); if (isEditing) updateSelectedOverlay({ vAlign: 'middle' }); }} className={`flex-1 p-1.5 rounded flex justify-center ${vAlign === 'middle' ? 'bg-slate-700 text-blue-400' : 'text-slate-500'}`} title="가운데"><AlignVerticalJustifyCenter size={16} /></button>
                  <button onClick={() => { setVAlign('bottom'); if (isEditing) updateSelectedOverlay({ vAlign: 'bottom' }); }} className={`flex-1 p-1.5 rounded flex justify-center ${vAlign === 'bottom' ? 'bg-slate-700 text-blue-400' : 'text-slate-500'}`} title="아래쪽"><AlignVerticalJustifyEnd size={16} /></button>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest">글꼴</label>
              <select 
                value={fontFamily}
                onChange={(e) => {
                  setFontFamily(e.target.value);
                  if (isEditing) updateSelectedOverlay({ fontFamily: e.target.value });
                }}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
              >
                {FONTS.map(f => <option key={f.value} value={f.value}>{f.name}</option>)}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 uppercase tracking-widest">크기</label>
                <input 
                  type="number" 
                  value={fontSize} 
                  onChange={(e) => {
                    const val = parseInt(e.target.value);
                    setFontSize(val);
                    if (isEditing) updateSelectedOverlay({ fontSize: val });
                  }}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500" 
                />
              </div>
              <div className="space-y-2">
                <label className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 uppercase tracking-widest">글자 색상</label>
                <div className="flex gap-2 items-center bg-slate-900 border border-slate-700 rounded-lg px-2 py-1">
                  <input 
                    type="color" 
                    value={fontColor} 
                    onChange={(e) => {
                      setFontColor(e.target.value);
                      if (isEditing) updateSelectedOverlay({ fontColor: e.target.value });
                    }}
                    className="w-8 h-8 bg-transparent cursor-pointer"
                  />
                  <span className="text-[10px] font-mono text-slate-400 uppercase">{fontColor}</span>
                </div>
              </div>
            </div>

            <div className="space-y-2">
               <label className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 uppercase tracking-widest">배경 색상 (Background)</label>
               <div className="flex items-center justify-between bg-slate-900 border border-slate-700 rounded-lg px-3 py-2">
                 <div className="flex items-center gap-3">
                   <div className="relative flex items-center">
                     <input 
                       type="color" 
                       value={backgroundColor}
                       disabled={isTransparent}
                       onChange={(e) => {
                         setBackgroundColor(e.target.value);
                         if (isEditing) updateSelectedOverlay({ backgroundColor: e.target.value });
                       }}
                       className={`w-6 h-6 bg-transparent border-none p-0 cursor-pointer ${isTransparent ? 'opacity-20 cursor-not-allowed' : ''}`}
                     />
                     {isTransparent && <div className="absolute inset-0 bg-slate-900/50 pointer-events-none" />}
                   </div>
                   <span className={`text-xs font-mono uppercase ${isTransparent ? 'text-slate-600' : 'text-slate-300'}`}>
                     {backgroundColor}
                   </span>
                 </div>
                 
                 <label className="flex items-center gap-2 cursor-pointer group select-none">
                   <input 
                     type="checkbox" 
                     checked={isTransparent}
                     onChange={(e) => {
                       const checked = e.target.checked;
                       setIsTransparent(checked);
                       if (isEditing) {
                         updateSelectedOverlay({ backgroundColor: checked ? 'rgba(0,0,0,0)' : backgroundColor });
                       }
                     }}
                     className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-blue-600 focus:ring-0 focus:ring-offset-0 transition-colors group-hover:border-slate-500"
                   />
                   <span className="text-xs text-slate-400 group-hover:text-slate-300 transition-colors">투명</span>
                 </label>
               </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 uppercase tracking-widest">두께</label>
                <div className="flex p-1 bg-slate-900 rounded-lg border border-slate-800">
                  <button 
                    onClick={() => { setFontWeight('normal'); if (isEditing) updateSelectedOverlay({ fontWeight: 'normal' }); }}
                    className={`flex-1 py-1.5 text-xs rounded transition-all ${fontWeight === 'normal' ? 'bg-slate-700 text-white' : 'text-slate-500'}`}
                  >
                    Normal
                  </button>
                  <button 
                    onClick={() => { setFontWeight('bold'); if (isEditing) updateSelectedOverlay({ fontWeight: 'bold' }); }}
                    className={`flex-1 py-1.5 text-xs font-bold rounded transition-all ${fontWeight === 'bold' ? 'bg-slate-700 text-white' : 'text-slate-500'}`}
                  >
                    Bold
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                <label className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 uppercase tracking-widest">자간 (Spacing)</label>
                <div className="flex items-center bg-slate-900 border border-slate-700 rounded-lg px-2">
                  <MoveHorizontal size={14} className="text-slate-500 mr-2" />
                  <input 
                    type="number" 
                    step="0.1"
                    value={letterSpacing} 
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      setLetterSpacing(val);
                      if (isEditing) updateSelectedOverlay({ letterSpacing: val });
                    }}
                    className="w-full bg-transparent py-2 text-sm focus:outline-none" 
                  />
                </div>
              </div>
            </div>

            {!isEditing && (
              <button 
                onClick={handleApply} 
                disabled={!selection} 
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold py-3 rounded-lg flex items-center justify-center gap-2 mt-2 shadow-lg active:scale-95 transition-all"
              >
                <CheckCircle2 size={18} /> 텍스트 적용
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default Sidebar;
