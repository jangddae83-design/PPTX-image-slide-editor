import React, { useRef, useEffect, useState, useCallback } from 'react';
import { SlideData, Rect, Point, HandleType, TextOverlay } from '../types';
import { COLORS, HANDLE_SIZE, MIN_RECT_SIZE, ZOOM_STEP, MAX_ZOOM, MIN_ZOOM, PAN_STEP } from '../constants';

interface EditorCanvasProps {
  slide: SlideData;
  selectedOverlayId: string | null;
  onSelectionChange: (rect: Rect | null) => void;
  onOverlaySelect: (id: string | null) => void;
  onUpdateOverlays: (overlays: TextOverlay[]) => void;
}

const EditorCanvas: React.FC<EditorCanvasProps> = ({ 
  slide, 
  selectedOverlayId,
  onSelectionChange, 
  onOverlaySelect,
  onUpdateOverlays 
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [selection, setSelection] = useState<Rect | null>(null);
  
  const [isDrawing, setIsDrawing] = useState(false);
  const [isResizingSelection, setIsResizingSelection] = useState(false);
  const [isDraggingOverlay, setIsDraggingOverlay] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  
  const [dragType, setDragType] = useState<'move' | HandleType | null>(null);
  const [startPoint, setStartPoint] = useState<Point | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);

  const [isSpacePressed, setIsSpacePressed] = useState(false);

  // --- 🔒 [성능 최적화] 터치/이동 중 60fps 부드러운 드로잉을 위한 Ref 버퍼 객체 ---
  const zoomRef = useRef(zoom);
  const offsetRef = useRef(offset);
  const transitionFrameLock = useRef(0);
  const touchStartRef = useRef<{
    distance: number;
    zoom: number;
    offset: Point;
    center: Point;
  } | null>(null);

  // Ref 버퍼와 React 상태값 동기화
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);

  // 키보드 이동 이벤트
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      if (e.code === 'Space') {
        if (isInput) return;
        setIsSpacePressed(e.type === 'keydown');
        if (e.type === 'keydown') e.preventDefault();
        return;
      }

      if (e.type === 'keydown' && !isInput) {
        let moved = false;
        if (e.code === 'ArrowUp') {
          offsetRef.current = { ...offsetRef.current, y: offsetRef.current.y + PAN_STEP };
          moved = true;
          e.preventDefault();
        } else if (e.code === 'ArrowDown') {
          offsetRef.current = { ...offsetRef.current, y: offsetRef.current.y - PAN_STEP };
          moved = true;
          e.preventDefault();
        } else if (e.code === 'ArrowLeft') {
          offsetRef.current = { ...offsetRef.current, x: offsetRef.current.x + PAN_STEP };
          moved = true;
          e.preventDefault();
        } else if (e.code === 'ArrowRight') {
          offsetRef.current = { ...offsetRef.current, x: offsetRef.current.x - PAN_STEP };
          moved = true;
          e.preventDefault();
        }

        if (moved) {
          setOffset(offsetRef.current);
          requestAnimationFrame(draw);
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    window.addEventListener('keyup', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('keyup', handleKey);
    };
  }, []);

  // 이미지 초기 로딩 시 크기 맞춤
  useEffect(() => {
    const img = new Image();
    img.src = slide.dataUrl;
    img.onload = () => {
      setImage(img);
      if (containerRef.current) {
        const { clientWidth, clientHeight } = containerRef.current;
        const scale = Math.min(
          (clientWidth - 80) / img.width,
          (clientHeight - 80) / img.height
        );
        zoomRef.current = scale;
        setZoom(scale);
        
        const initialOffset = {
          x: (clientWidth - img.width * scale) / 2,
          y: (clientHeight - img.height * scale) / 2
        };
        offsetRef.current = initialOffset;
        setOffset(initialOffset);
      }
    };
  }, [slide.dataUrl]);

  // 마우스 휠 스냅 줌
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheelNative = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const delta = -e.deltaY;
        const factor = delta > 0 ? (1 + ZOOM_STEP) : (1 - ZOOM_STEP);
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const currentZoom = zoomRef.current;
        const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, currentZoom * factor));
        
        const wx = (mouseX - offsetRef.current.x) / currentZoom;
        const wy = (mouseY - offsetRef.current.y) / currentZoom;
        
        zoomRef.current = newZoom;
        offsetRef.current = {
          x: mouseX - wx * newZoom,
          y: mouseY - wy * newZoom
        };
        
        setZoom(newZoom);
        setOffset(offsetRef.current);
        requestAnimationFrame(draw);
      } else if (!isSpacePressed) {
        offsetRef.current = {
          x: offsetRef.current.x - e.deltaX,
          y: offsetRef.current.y - e.deltaY
        };
        setOffset(offsetRef.current);
        requestAnimationFrame(draw);
      }
    };

    container.addEventListener('wheel', handleWheelNative, { passive: false });
    return () => container.removeEventListener('wheel', handleWheelNative);
  }, [isSpacePressed]);

  // --- 🎨 [해상도 보정] 2D 캔버스 드로잉 엔진 (Retina 대응) ---
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !image) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    
    // 고해상도 백킹 스토어 스케일링 설정
    if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    
    // Retina 화소 해상도 매칭
    ctx.scale(dpr, dpr);

    ctx.translate(offsetRef.current.x, offsetRef.current.y);
    ctx.scale(zoomRef.current, zoomRef.current);

    ctx.drawImage(image, 0, 0);

    slide.overlays.forEach(overlay => {
      ctx.fillStyle = overlay.backgroundColor;
      ctx.fillRect(overlay.rect.x, overlay.rect.y, overlay.rect.width, overlay.rect.height);
      
      if (overlay.id === selectedOverlayId) {
        ctx.strokeStyle = COLORS.primary;
        ctx.lineWidth = 2 / zoomRef.current;
        ctx.strokeRect(overlay.rect.x, overlay.rect.y, overlay.rect.width, overlay.rect.height);
      }

      ctx.fillStyle = overlay.fontColor;
      ctx.font = `${overlay.fontWeight} ${overlay.fontSize}px ${overlay.fontFamily}, sans-serif`;
      
      if (ctx.letterSpacing !== undefined) {
        ctx.letterSpacing = `${overlay.letterSpacing || 0}px`;
      }
      
      const lines = overlay.newText.split('\n');
      const lineHeight = overlay.fontSize * 1.2;
      const totalTextHeight = lines.length * lineHeight;

      ctx.textAlign = (overlay.hAlign || 'left') as CanvasTextAlign;
      ctx.textBaseline = 'top';

      let tx = overlay.rect.x;
      if (overlay.hAlign === 'center') tx = overlay.rect.x + overlay.rect.width / 2;
      else if (overlay.hAlign === 'right') tx = overlay.rect.x + overlay.rect.width;

      let ty = overlay.rect.y;
      if (overlay.vAlign === 'middle') ty = overlay.rect.y + (overlay.rect.height - totalTextHeight) / 2;
      else if (overlay.vAlign === 'bottom') ty = overlay.rect.y + overlay.rect.height - totalTextHeight;

      lines.forEach((line, index) => {
        ctx.fillText(line, tx, ty + index * lineHeight);
      });
      
      if (ctx.letterSpacing !== undefined) {
        ctx.letterSpacing = '0px';
      }
    });

    if (selection) {
      ctx.strokeStyle = COLORS.primary;
      ctx.lineWidth = 2 / zoomRef.current;
      ctx.strokeRect(selection.x, selection.y, selection.width, selection.height);
      ctx.fillStyle = COLORS.overlay;
      ctx.fillRect(selection.x, selection.y, selection.width, selection.height);

      const handles: Point[] = [
        { x: selection.x, y: selection.y },
        { x: selection.x + selection.width / 2, y: selection.y },
        { x: selection.x + selection.width, y: selection.y },
        { x: selection.x + selection.width, y: selection.y + selection.height / 2 },
        { x: selection.x + selection.width, y: selection.y + selection.height },
        { x: selection.x + selection.width / 2, y: selection.y + selection.height },
        { x: selection.x, y: selection.y + selection.height },
        { x: selection.x, y: selection.y + selection.height / 2 },
      ];

      ctx.fillStyle = COLORS.handle;
      handles.forEach(h => {
        ctx.fillRect(
          h.x - (HANDLE_SIZE / 2) / zoomRef.current, 
          h.y - (HANDLE_SIZE / 2) / zoomRef.current, 
          HANDLE_SIZE / zoomRef.current, 
          HANDLE_SIZE / zoomRef.current
        );
      });
    }

    ctx.restore();
  }, [image, slide.overlays, selection, selectedOverlayId]);

  useEffect(() => {
    draw();
  }, [draw]);

  const getCanvasCoords = (e: React.MouseEvent | any): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - offsetRef.current.x) / zoomRef.current,
      y: (e.clientY - rect.top - offsetRef.current.y) / zoomRef.current
    };
  };

  const getScreenCoords = (e: React.MouseEvent | any): Point => ({ x: e.clientX, y: e.clientY });

  const isPointInRect = (p: Point, rect: Rect) => {
    return p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height;
  };

  const getHandleAt = (p: Point, rect: Rect): HandleType | null => {
    const tolerance = HANDLE_SIZE / zoomRef.current;
    const hx = [rect.x, rect.x + rect.width / 2, rect.x + rect.width];
    const hy = [rect.y, rect.y + rect.height / 2, rect.y + rect.height];
    const types: (HandleType | null)[][] = [
      ['nw', 'n', 'ne'],
      ['w', null, 'e'],
      ['sw', 's', 'se']
    ];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const type = types[i][j];
        if (type && Math.abs(p.x - hx[j]) < tolerance && Math.abs(p.y - hy[i]) < tolerance) return type;
      }
    }
    return null;
  };

  // --- 🖱️ 마우스 이벤트 핸들러 ---
  const handleMouseDown = (e: React.MouseEvent) => {
    if (isSpacePressed || e.button === 1) {
      setIsPanning(true);
      setStartPoint(getScreenCoords(e));
      return;
    }

    const p = getCanvasCoords(e);
    
    if (selection) {
      const handle = getHandleAt(p, selection);
      if (handle) {
        setIsResizingSelection(true);
        setDragType(handle);
        setStartPoint(p);
        return;
      }
    }

    const clickedOverlay = [...slide.overlays].reverse().find(o => isPointInRect(p, o.rect));
    if (clickedOverlay) {
      onOverlaySelect(clickedOverlay.id);
      setIsDraggingOverlay(true);
      setStartPoint(p);
      setSelection(null);
      onSelectionChange(null);
      return;
    }

    onOverlaySelect(null);
    setIsDrawing(true);
    const newSelection = { x: p.x, y: p.y, width: 0, height: 0 };
    setSelection(newSelection);
    setStartPoint(p);
    onSelectionChange(null);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const screenP = getScreenCoords(e);
    const canvasP = getCanvasCoords(e);
    
    if (canvasRef.current) {
      if (isSpacePressed || isPanning) canvasRef.current.style.cursor = isPanning ? 'grabbing' : 'grab';
      else if (isDraggingOverlay) canvasRef.current.style.cursor = 'grabbing';
      else if (isResizingSelection) canvasRef.current.style.cursor = 'nwse-resize';
      else if (slide.overlays.some(o => isPointInRect(canvasP, o.rect))) canvasRef.current.style.cursor = 'pointer';
      else if (selection && getHandleAt(canvasP, selection)) canvasRef.current.style.cursor = 'crosshair';
      else canvasRef.current.style.cursor = 'default';
    }

    // 1. 화면 패닝 처리
    if (isPanning && startPoint) {
      const dx = screenP.x - startPoint.x;
      const dy = screenP.y - startPoint.y;
      offsetRef.current = { x: offsetRef.current.x + dx, y: offsetRef.current.y + dy };
      setStartPoint(screenP);
      requestAnimationFrame(draw);
      return;
    }

    // 🌟 [Figma 기능] 엣지 접근 시 자동 스크롤 (Boundary Auto-Panning)
    if ((isDrawing || isDraggingOverlay || isResizingSelection) && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const margin = 40;
      const panSpeed = 6;
      let pdx = 0;
      let pdy = 0;

      if (e.clientX < rect.left + margin) pdx = panSpeed;
      else if (e.clientX > rect.right - margin) pdx = -panSpeed;

      if (e.clientY < rect.top + margin) pdy = panSpeed;
      else if (e.clientY > rect.bottom - margin) pdy = -panSpeed;

      if (pdx !== 0 || pdy !== 0) {
        offsetRef.current = {
          x: offsetRef.current.x + pdx,
          y: offsetRef.current.y + pdy
        };
        requestAnimationFrame(draw);
      }
    }

    // 2. 영역 그리기 및 편집 처리
    if (isDrawing && startPoint) {
      const x = Math.min(canvasP.x, startPoint.x);
      const y = Math.min(canvasP.y, startPoint.y);
      const width = Math.abs(canvasP.x - startPoint.x);
      const height = Math.abs(canvasP.y - startPoint.y);
      setSelection({ x, y, width, height });
    } else if (isResizingSelection && selection && startPoint && dragType) {
      const dx = canvasP.x - startPoint.x;
      const dy = canvasP.y - startPoint.y;
      let newRect = { ...selection };
      if (dragType.includes('e')) newRect.width += dx;
      if (dragType.includes('w')) { newRect.x += dx; newRect.width -= dx; }
      if (dragType.includes('s')) newRect.height += dy;
      if (dragType.includes('n')) { newRect.y += dy; newRect.height -= dy; }
      setSelection(newRect);
      setStartPoint(canvasP);
    } else if (isDraggingOverlay && selectedOverlayId && startPoint) {
      const dx = canvasP.x - startPoint.x;
      const dy = canvasP.y - startPoint.y;
      const newOverlays = slide.overlays.map(ov => ov.id === selectedOverlayId ? { ...ov, rect: { ...ov.rect, x: ov.rect.x + dx, y: ov.rect.y + dy } } : ov);
      onUpdateOverlays(newOverlays);
      setStartPoint(canvasP);
    }
  };

  const handleMouseUp = () => {
    if (isDrawing || isResizingSelection) {
      if (selection && (selection.width < MIN_RECT_SIZE || selection.height < MIN_RECT_SIZE)) {
        setSelection(null);
        onSelectionChange(null);
      } else {
        onSelectionChange(selection);
      }
    }
    setIsDrawing(false);
    setIsDraggingOverlay(false);
    setIsResizingSelection(false);
    setIsPanning(false);
    setStartPoint(null);
    
    // 최종 상태값 React에 기입
    setZoom(zoomRef.current);
    setOffset(offsetRef.current);
  };

  // --- 📱 모바일/태블릿 터치 제스처 핸들러 ---
  const getDistance = (p1: Point, p2: Point) => {
    return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
  };

  const getCenterPoint = (p1: Point, p2: Point): Point => {
    return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (e.touches.length === 1) {
      // 1핑거 -> 마우스 오버레이 조작/그리기 시뮬레이션
      const touch = e.touches[0];
      const p = getCanvasCoords({ clientX: touch.clientX, clientY: touch.clientY });
      
      const isOverOverlay = slide.overlays.some(o => isPointInRect(p, o.rect));
      const isOverHandle = selection && getHandleAt(p, selection);
      
      // 조작 시 스크롤 간섭 예방을 위한 prevent
      if (isOverOverlay || isOverHandle || !isSpacePressed) {
        e.preventDefault();
      }

      handleMouseDown({
        clientX: touch.clientX,
        clientY: touch.clientY,
        button: 0,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as any);
    } else if (e.touches.length === 2) {
      // 2핑거 -> 핀치 투 줌 & 팬 모드 활성화
      e.preventDefault();
      setIsPanning(false);
      setIsDrawing(false);
      setIsDraggingOverlay(false);
      setIsResizingSelection(false);

      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const p1 = { x: t1.clientX, y: t1.clientY };
      const p2 = { x: t2.clientX, y: t2.clientY };

      const dist = getDistance(p1, p2);
      const center = getCenterPoint(p1, p2);

      touchStartRef.current = {
        distance: dist,
        zoom: zoomRef.current,
        offset: { ...offsetRef.current },
        center: center
      };
      
      // 전환 프레임 튀김 방지 락
      transitionFrameLock.current = 5;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (e.touches.length === 1) {
      const touch = e.touches[0];
      
      if (isDrawing || isDraggingOverlay || isResizingSelection) {
        e.preventDefault();
      }
      
      handleMouseMove({
        clientX: touch.clientX,
        clientY: touch.clientY,
        preventDefault: () => {},
      } as any);
    } else if (e.touches.length === 2 && touchStartRef.current) {
      e.preventDefault();
      
      if (transitionFrameLock.current > 0) {
        transitionFrameLock.current--;
        return;
      }

      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const p1 = { x: t1.clientX, y: t1.clientY };
      const p2 = { x: t2.clientX, y: t2.clientY };

      const currentDist = getDistance(p1, p2);
      const currentCenter = getCenterPoint(p1, p2);

      if (touchStartRef.current.distance > 2) {
        const factor = currentDist / touchStartRef.current.distance;
        
        // 1. 배율 계산 및 범위 제한
        const targetZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, touchStartRef.current.zoom * factor));
        
        // 2. 중심점 이동 감지 (팬)
        const dx = currentCenter.x - touchStartRef.current.center.x;
        const dy = currentCenter.y - touchStartRef.current.center.y;
        
        // 3. 핀치 중심 위치 기준 오프셋 보정
        const rect = canvas.getBoundingClientRect();
        const centerCanvasX = currentCenter.x - rect.left;
        const centerCanvasY = currentCenter.y - rect.top;

        const startOffset = touchStartRef.current.offset;
        const oldZoom = touchStartRef.current.zoom;

        const wx = (centerCanvasX - startOffset.x) / oldZoom;
        const wy = (centerCanvasY - startOffset.y) / oldZoom;

        zoomRef.current = targetZoom;
        offsetRef.current = {
          x: centerCanvasX - wx * targetZoom + dx,
          y: centerCanvasY - wy * targetZoom + dy
        };

        requestAnimationFrame(draw);
      }
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length === 0) {
      touchStartRef.current = null;
      setZoom(zoomRef.current);
      setOffset(offsetRef.current);
      handleMouseUp();
    } else if (e.touches.length === 1) {
      // 2개 손가락 중 하나를 떼었을 때 발생하는 급격한 변동 락 적용
      transitionFrameLock.current = 5;
      touchStartRef.current = null;
      setZoom(zoomRef.current);
      setOffset(offsetRef.current);
    }
  };

  return (
    <div ref={containerRef} className="flex-1 relative overflow-hidden bg-[#0f172a] flex items-center justify-center select-none touch-none">
      <canvas 
        ref={canvasRef} 
        onMouseDown={handleMouseDown} 
        onMouseMove={handleMouseMove} 
        onMouseUp={handleMouseUp} 
        onMouseLeave={handleMouseUp} 
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onContextMenu={(e) => e.preventDefault()} 
        className="block w-full h-full" 
      />
      
      {/* 🧭 브라우저 조작 정보 인포바 (모바일은 터치 팁) */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-slate-800/90 px-4 py-2.5 rounded-full text-[10px] font-medium text-slate-200 border border-slate-700 shadow-2xl pointer-events-none flex items-center gap-4 backdrop-blur-sm max-sm:hidden">
        <div className="flex items-center gap-1.5">
          <span className="bg-slate-700 px-1.5 py-0.5 rounded text-[9px] text-blue-400 font-bold">2-Finger / Space + Drag</span>
          <span>화면 이동</span>
        </div>
        <div className="w-px h-3 bg-slate-600"></div>
        <div className="flex items-center gap-1.5">
          <span className="bg-slate-700 px-1.5 py-0.5 rounded text-[9px] text-blue-400 font-bold">Pinch / Ctrl + Wheel</span>
          <span>확대/축소</span>
        </div>
      </div>

      {/* 🔍 플로팅 유리질감 줌 컨트롤 툴바 */}
      <div className="absolute bottom-4 left-4 bg-slate-800/80 backdrop-blur-md px-3 py-1.5 rounded-xl border border-slate-700 shadow-2xl flex items-center gap-2.5 text-slate-200">
        <button 
          onClick={() => {
            const nextZoom = Math.max(MIN_ZOOM, zoomRef.current - 0.2);
            zoomRef.current = nextZoom;
            setZoom(nextZoom);
            requestAnimationFrame(draw);
          }}
          className="w-6 h-6 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white transition-all text-sm font-black flex items-center justify-center"
          title="축소"
        >
          -
        </button>
        <span className="text-[10px] font-black tracking-wider min-w-[36px] text-center">
          {Math.round(zoomRef.current * 100)}%
        </span>
        <button 
          onClick={() => {
            const nextZoom = Math.min(MAX_ZOOM, zoomRef.current + 0.2);
            zoomRef.current = nextZoom;
            setZoom(nextZoom);
            requestAnimationFrame(draw);
          }}
          className="w-6 h-6 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white transition-all text-sm font-black flex items-center justify-center"
          title="확대"
        >
          +
        </button>
        <div className="w-px h-3 bg-slate-700"></div>
        <button 
          onClick={() => {
            if (containerRef.current && image) {
              const { clientWidth, clientHeight } = containerRef.current;
              const scale = Math.min(
                (clientWidth - 80) / image.width,
                (clientHeight - 80) / image.height
              );
              zoomRef.current = scale;
              offsetRef.current = {
                x: (clientWidth - image.width * scale) / 2,
                y: (clientHeight - image.height * scale) / 2
              };
              setZoom(scale);
              setOffset(offsetRef.current);
              requestAnimationFrame(draw);
            }
          }}
          className="px-2 py-0.5 hover:bg-slate-700 rounded-lg text-[9px] font-bold text-blue-400 hover:text-blue-300 transition-all uppercase tracking-wider"
          title="화면에 맞춤"
        >
          Fit
        </button>
      </div>
    </div>
  );
};

export default EditorCanvas;
