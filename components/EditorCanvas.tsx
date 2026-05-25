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
  const zoomTextRef = useRef<HTMLSpanElement>(null);
  
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [selection, setSelection] = useState<Rect | null>(null);
  
  const [isDrawing, setIsDrawing] = useState(false);
  const [isResizingSelection, setIsResizingSelection] = useState(false);
  const [isDraggingOverlay, setIsDraggingOverlay] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  
  // 텍스트 오버레이 드래그 시 글로벌 리렌더링(120Hz) 방지를 위한 로컬 델타 Ref
  const dragOverlayDeltaRef = useRef({ dx: 0, dy: 0 });
  
  const [dragType, setDragType] = useState<'move' | HandleType | null>(null);
  const [startPoint, setStartPoint] = useState<Point | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);

  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [isHandTool, setIsHandTool] = useState(false);

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
  const rafId = useRef<number | null>(null);

  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { offsetRef.current = offset; }, [offset]);

  // --- 🎨 [해상도 보정 및 텍스트 렌더링] 2D 캔버스 드로잉 엔진 ---
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !image) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    
    if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(offsetRef.current.x, offsetRef.current.y);
    ctx.scale(zoomRef.current, zoomRef.current);
    ctx.drawImage(image, 0, 0);

    const dragDelta = isDraggingOverlay ? dragOverlayDeltaRef.current : { dx: 0, dy: 0 };

    slide.overlays.forEach(overlay => {
      // 드래그 중인 오버레이는 임시 델타값을 적용하여 렌더링 (리액트 상태 우회)
      const currentRect = (overlay.id === selectedOverlayId) 
        ? { ...overlay.rect, x: overlay.rect.x + dragDelta.dx, y: overlay.rect.y + dragDelta.dy }
        : overlay.rect;

      ctx.fillStyle = overlay.backgroundColor;
      ctx.fillRect(currentRect.x, currentRect.y, currentRect.width, currentRect.height);
      
      if (overlay.id === selectedOverlayId) {
        ctx.strokeStyle = COLORS.primary;
        ctx.lineWidth = 2 / zoomRef.current;
        ctx.strokeRect(currentRect.x, currentRect.y, currentRect.width, currentRect.height);
      }

      ctx.fillStyle = overlay.fontColor;
      ctx.font = `${overlay.fontWeight} ${overlay.fontSize}px ${overlay.fontFamily}, sans-serif`;
      
      if (ctx.letterSpacing !== undefined) {
        ctx.letterSpacing = `${overlay.letterSpacing || 0}px`;
      }
      
      // Auto Word-Wrap 엔진 적용
      const maxWidth = currentRect.width > 8 ? currentRect.width - 4 : currentRect.width;
      const paragraphs = overlay.newText.split('\n');
      const lines: string[] = [];
      
      paragraphs.forEach(p => {
        if (p.length === 0) { lines.push(''); return; }
        let currentLine = '';
        for (let i = 0; i < p.length; i++) {
          const char = p[i];
          const testLine = currentLine + char;
          const metrics = ctx.measureText(testLine);
          if (metrics.width > maxWidth && currentLine.length > 0) {
            lines.push(currentLine);
            currentLine = char;
          } else {
            currentLine = testLine;
          }
        }
        lines.push(currentLine);
      });

      const lineHeight = overlay.fontSize * 1.2;
      const totalTextHeight = lines.length * lineHeight;

      ctx.textAlign = (overlay.hAlign || 'left') as CanvasTextAlign;
      ctx.textBaseline = 'top';

      let tx = currentRect.x + 2; // slight padding
      if (overlay.hAlign === 'center') tx = currentRect.x + currentRect.width / 2;
      else if (overlay.hAlign === 'right') tx = currentRect.x + currentRect.width - 2;

      let ty = currentRect.y;
      if (overlay.vAlign === 'middle') ty = currentRect.y + (currentRect.height - totalTextHeight) / 2;
      else if (overlay.vAlign === 'bottom') ty = currentRect.y + currentRect.height - totalTextHeight;

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

    // DOM Direct Injection (UI 실시간 동기화)
    if (zoomTextRef.current) {
      zoomTextRef.current.innerText = `${Math.round(zoomRef.current * 100)}%`;
    }
  }, [image, slide.overlays, selection, selectedOverlayId, isDraggingOverlay]);

  // RAF Debounce 래퍼
  const scheduleDraw = useCallback(() => {
    if (rafId.current === null) {
      rafId.current = requestAnimationFrame(() => {
        draw();
        rafId.current = null;
      });
    }
  }, [draw]);

  useEffect(() => {
    scheduleDraw();
  }, [scheduleDraw]);

  // 키보드 이동 이벤트 및 Blur(Sticky Key) 방지
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
        if (e.code === 'ArrowUp') { offsetRef.current = { ...offsetRef.current, y: offsetRef.current.y + PAN_STEP }; moved = true; e.preventDefault(); }
        else if (e.code === 'ArrowDown') { offsetRef.current = { ...offsetRef.current, y: offsetRef.current.y - PAN_STEP }; moved = true; e.preventDefault(); }
        else if (e.code === 'ArrowLeft') { offsetRef.current = { ...offsetRef.current, x: offsetRef.current.x + PAN_STEP }; moved = true; e.preventDefault(); }
        else if (e.code === 'ArrowRight') { offsetRef.current = { ...offsetRef.current, x: offsetRef.current.x - PAN_STEP }; moved = true; e.preventDefault(); }

        if (moved) {
          setOffset(offsetRef.current);
          scheduleDraw();
        }
      }
    };
    const handleBlur = () => setIsSpacePressed(false);
    
    window.addEventListener('keydown', handleKey);
    window.addEventListener('keyup', handleKey);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('keyup', handleKey);
      window.removeEventListener('blur', handleBlur);
    };
  }, [scheduleDraw]);

  // 이미지 비동기 로딩 (Abort Controller 패턴)
  useEffect(() => {
    let isCancelled = false;
    const img = new Image();
    img.src = slide.dataUrl;
    img.onload = () => {
      if (isCancelled) return;
      setImage(img);
      if (containerRef.current) {
        const { clientWidth, clientHeight } = containerRef.current;
        const scale = Math.min((clientWidth - 80) / img.width, (clientHeight - 80) / img.height);
        zoomRef.current = scale;
        setZoom(scale);
        const initialOffset = { x: (clientWidth - img.width * scale) / 2, y: (clientHeight - img.height * scale) / 2 };
        offsetRef.current = initialOffset;
        setOffset(initialOffset);
        scheduleDraw();
      }
    };
    return () => { isCancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slide.dataUrl]);

  // ResizeObserver 반응형 체인
  useEffect(() => {
    if (!containerRef.current || !image) return;
    const observer = new ResizeObserver(() => {
      scheduleDraw();
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [image, scheduleDraw]);

  // 좌표 계산 유틸리티
  const getCanvasCoords = (clientX: number, clientY: number): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - offsetRef.current.x) / zoomRef.current,
      y: (clientY - rect.top - offsetRef.current.y) / zoomRef.current
    };
  };
  const getScreenCoords = (clientX: number, clientY: number): Point => ({ x: clientX, y: clientY });

  const isPointInRect = (p: Point, rect: Rect) => p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height;

  const getHandleAt = (p: Point, rect: Rect): HandleType | null => {
    const tolerance = HANDLE_SIZE / zoomRef.current;
    const hx = [rect.x, rect.x + rect.width / 2, rect.x + rect.width];
    const hy = [rect.y, rect.y + rect.height / 2, rect.y + rect.height];
    const types: (HandleType | null)[][] = [['nw', 'n', 'ne'], ['w', null, 'e'], ['sw', 's', 'se']];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const type = types[i][j];
        if (type && Math.abs(p.x - hx[j]) < tolerance && Math.abs(p.y - hy[i]) < tolerance) return type;
      }
    }
    return null;
  };

  // --- 이벤트 헨들러 로직 (Latest-Closure 방식을 위해 일반 함수로 정의 후 Ref로 위임) ---
  const handleMouseDownRaw = (clientX: number, clientY: number, button: number = 0) => {
    if (isHandTool || isSpacePressed || button === 1) {
      setIsPanning(true);
      setStartPoint(getScreenCoords(clientX, clientY));
      return;
    }
    const p = getCanvasCoords(clientX, clientY);
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
      dragOverlayDeltaRef.current = { dx: 0, dy: 0 };
      setStartPoint(p);
      setSelection(null);
      onSelectionChange(null);
      return;
    }
    onOverlaySelect(null);
    setIsDrawing(true);
    setSelection({ x: p.x, y: p.y, width: 0, height: 0 });
    setStartPoint(p);
    onSelectionChange(null);
  };

  const handleMouseMoveRaw = (clientX: number, clientY: number) => {
    const screenP = getScreenCoords(clientX, clientY);
    const canvasP = getCanvasCoords(clientX, clientY);
    
    if (canvasRef.current) {
      if (isHandTool || isSpacePressed || isPanning) canvasRef.current.style.cursor = isPanning ? 'grabbing' : 'grab';
      else if (isDraggingOverlay) canvasRef.current.style.cursor = 'grabbing';
      else if (isResizingSelection) canvasRef.current.style.cursor = 'nwse-resize';
      else if (slide.overlays.some(o => isPointInRect(canvasP, o.rect))) canvasRef.current.style.cursor = 'pointer';
      else if (selection && getHandleAt(canvasP, selection)) canvasRef.current.style.cursor = 'crosshair';
      else canvasRef.current.style.cursor = 'default';
    }

    if (isPanning && startPoint) {
      const dx = screenP.x - startPoint.x;
      const dy = screenP.y - startPoint.y;
      offsetRef.current = { x: offsetRef.current.x + dx, y: offsetRef.current.y + dy };
      setStartPoint(screenP);
      scheduleDraw();
      return;
    }

    if ((isDrawing || isDraggingOverlay || isResizingSelection) && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const margin = 40;
      const panSpeed = 6;
      let pdx = 0; let pdy = 0;
      if (clientX < rect.left + margin) pdx = panSpeed;
      else if (clientX > rect.right - margin) pdx = -panSpeed;
      if (clientY < rect.top + margin) pdy = panSpeed;
      else if (clientY > rect.bottom - margin) pdy = -panSpeed;

      if (pdx !== 0 || pdy !== 0) {
        offsetRef.current = { x: offsetRef.current.x + pdx, y: offsetRef.current.y + pdy };
        scheduleDraw();
      }
    }

    if (isDrawing && startPoint) {
      setSelection({
        x: Math.min(canvasP.x, startPoint.x),
        y: Math.min(canvasP.y, startPoint.y),
        width: Math.abs(canvasP.x - startPoint.x),
        height: Math.abs(canvasP.y - startPoint.y)
      });
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
      dragOverlayDeltaRef.current = { dx, dy };
      scheduleDraw();
    }
  };

  const handleMouseUpRaw = () => {
    if (isDrawing || isResizingSelection) {
      if (selection && (selection.width < MIN_RECT_SIZE || selection.height < MIN_RECT_SIZE)) {
        setSelection(null);
        onSelectionChange(null);
      } else {
        onSelectionChange(selection);
      }
    }
    if (isDraggingOverlay && selectedOverlayId) {
      // 드래그 종료 시점에 단 1번만 부모 상태 업데이트
      const delta = dragOverlayDeltaRef.current;
      if (delta.dx !== 0 || delta.dy !== 0) {
        const newOverlays = slide.overlays.map(ov => 
          ov.id === selectedOverlayId ? { ...ov, rect: { ...ov.rect, x: ov.rect.x + delta.dx, y: ov.rect.y + delta.dy } } : ov
        );
        onUpdateOverlays(newOverlays);
        dragOverlayDeltaRef.current = { dx: 0, dy: 0 };
      }
    }

    setIsDrawing(false);
    setIsDraggingOverlay(false);
    setIsResizingSelection(false);
    setIsPanning(false);
    setStartPoint(null);
    setZoom(zoomRef.current);
    setOffset(offsetRef.current);
  };

  const handleWheelNativeRaw = (e: WheelEvent) => {
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
      offsetRef.current = { x: mouseX - wx * newZoom, y: mouseY - wy * newZoom };
      
      setZoom(newZoom);
      setOffset(offsetRef.current);
      scheduleDraw();
    } else if (!isSpacePressed) {
      offsetRef.current = { x: offsetRef.current.x - e.deltaX, y: offsetRef.current.y - e.deltaY };
      setOffset(offsetRef.current);
      scheduleDraw();
    }
  };

  const handleTouchStartRaw = (e: TouchEvent) => {
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const p = getCanvasCoords(touch.clientX, touch.clientY);
      const isOverOverlay = slide.overlays.some(o => isPointInRect(p, o.rect));
      const isOverHandle = selection && getHandleAt(p, selection);
      
      if (isHandTool || isOverOverlay || isOverHandle || !isSpacePressed) e.preventDefault();
      handleMouseDownRaw(touch.clientX, touch.clientY, 0);
    } else if (e.touches.length === 2) {
      e.preventDefault();
      setIsPanning(false); setIsDrawing(false); setIsDraggingOverlay(false); setIsResizingSelection(false);
      const t1 = e.touches[0]; const t2 = e.touches[1];
      const p1 = { x: t1.clientX, y: t1.clientY }; const p2 = { x: t2.clientX, y: t2.clientY };
      touchStartRef.current = {
        distance: Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2)),
        zoom: zoomRef.current,
        offset: { ...offsetRef.current },
        center: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
      };
      transitionFrameLock.current = 5;
    }
  };

  const handleTouchMoveRaw = (e: TouchEvent) => {
    if (e.touches.length === 1) {
      if (isHandTool || isDrawing || isDraggingOverlay || isResizingSelection) e.preventDefault();
      handleMouseMoveRaw(e.touches[0].clientX, e.touches[0].clientY);
    } else if (e.touches.length === 2 && touchStartRef.current) {
      e.preventDefault();
      if (transitionFrameLock.current > 0) { transitionFrameLock.current--; return; }

      const t1 = e.touches[0]; const t2 = e.touches[1];
      const p1 = { x: t1.clientX, y: t1.clientY }; const p2 = { x: t2.clientX, y: t2.clientY };
      const currentDist = Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
      const currentCenter = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };

      if (touchStartRef.current.distance > 2) {
        const factor = currentDist / touchStartRef.current.distance;
        const targetZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, touchStartRef.current.zoom * factor));
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        
        const startCenterCanvasX = touchStartRef.current.center.x - rect.left;
        const startCenterCanvasY = touchStartRef.current.center.y - rect.top;
        const wx = (startCenterCanvasX - touchStartRef.current.offset.x) / touchStartRef.current.zoom;
        const wy = (startCenterCanvasY - touchStartRef.current.offset.y) / touchStartRef.current.zoom;
        const dx = currentCenter.x - touchStartRef.current.center.x;
        const dy = currentCenter.y - touchStartRef.current.center.y;

        zoomRef.current = targetZoom;
        offsetRef.current = {
          x: startCenterCanvasX - wx * targetZoom + dx,
          y: startCenterCanvasY - wy * targetZoom + dy
        };
        scheduleDraw();
      }
    }
  };

  const handleTouchEndRaw = (e: TouchEvent) => {
    if (e.touches.length === 0) {
      touchStartRef.current = null;
      setZoom(zoomRef.current);
      setOffset(offsetRef.current);
      handleMouseUpRaw();
    } else if (e.touches.length === 1) {
      transitionFrameLock.current = 5;
      touchStartRef.current = null;
      setZoom(zoomRef.current);
      setOffset(offsetRef.current);
    }
  };

  // --- handlersRef 위임 ---
  const handlersRef = useRef({
    handleMouseDownRaw, handleMouseMoveRaw, handleMouseUpRaw,
    handleWheelNativeRaw, handleTouchStartRaw, handleTouchMoveRaw, handleTouchEndRaw
  });
  useEffect(() => {
    handlersRef.current = {
      handleMouseDownRaw, handleMouseMoveRaw, handleMouseUpRaw,
      handleWheelNativeRaw, handleTouchStartRaw, handleTouchMoveRaw, handleTouchEndRaw
    };
  });

  // DOM Event Thrashing 방어용 단발성 결합
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const onWheel = (e: WheelEvent) => handlersRef.current.handleWheelNativeRaw(e);
    const onTouchStart = (e: TouchEvent) => handlersRef.current.handleTouchStartRaw(e);
    const onTouchMove = (e: TouchEvent) => handlersRef.current.handleTouchMoveRaw(e);
    const onTouchEnd = (e: TouchEvent) => handlersRef.current.handleTouchEndRaw(e);

    container.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });

    return () => {
      container.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('touchcancel', onTouchEnd);
    };
  }, []);

  // 글로벌 드래그 오버라이드 (마우스 이탈 대응)
  useEffect(() => {
    if (!isDrawing && !isDraggingOverlay && !isResizingSelection && !isPanning) return;
    const onMouseMove = (e: MouseEvent) => handlersRef.current.handleMouseMoveRaw(e.clientX, e.clientY);
    const onMouseUp = () => handlersRef.current.handleMouseUpRaw();
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isDrawing, isDraggingOverlay, isResizingSelection, isPanning]);

  return (
    <div ref={containerRef} className="flex-1 relative overflow-hidden bg-[#0f172a] flex items-center justify-center select-none touch-none">
      <canvas 
        ref={canvasRef} 
        onMouseDown={(e) => handlersRef.current.handleMouseDownRaw(e.clientX, e.clientY, e.button)}
        onContextMenu={(e) => e.preventDefault()} 
        className="block w-full h-full" 
      />
      
      <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-slate-800/90 px-4 py-2.5 rounded-full text-[10px] font-medium text-slate-200 border border-slate-700 shadow-2xl pointer-events-none flex items-center gap-4 backdrop-blur-sm max-sm:hidden">
        <div className="flex items-center gap-1.5"><span className="bg-slate-700 px-1.5 py-0.5 rounded text-[9px] text-blue-400 font-bold">2-Finger / Space + Drag</span><span>화면 이동</span></div>
        <div className="w-px h-3 bg-slate-600"></div>
        <div className="flex items-center gap-1.5"><span className="bg-slate-700 px-1.5 py-0.5 rounded text-[9px] text-blue-400 font-bold">Pinch / Ctrl + Wheel</span><span>확대/축소</span></div>
      </div>

      <div className="absolute bottom-4 left-4 bg-slate-800/90 backdrop-blur-md px-3 py-1.5 rounded-xl border border-slate-700 shadow-2xl flex items-center gap-2.5 text-slate-200">
        <div className="flex bg-slate-900/60 p-0.5 rounded-lg border border-slate-750 shrink-0">
          <button onClick={() => setIsHandTool(false)} className={`w-6 h-6 rounded flex items-center justify-center transition-all ${!isHandTool ? 'bg-slate-700 text-blue-400' : 'text-slate-500 hover:text-slate-300'}`} title="선택 도구 (Selection)">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polygon points="3 3 10.07 19.97 12.58 12.58 19.97 10.07 3 3" /></svg>
          </button>
          <button onClick={() => setIsHandTool(true)} className={`w-6 h-6 rounded flex items-center justify-center transition-all ${isHandTool ? 'bg-slate-700 text-blue-400' : 'text-slate-500 hover:text-slate-300'}`} title="손 도구 (Hand / Pan)">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v5" /><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v6" /><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8" /><path d="M18 8a2 2 0 0 1 2 2v9a6 6 0 0 1-6 6v0a6 6 0 0 1-6-6v-1" /></svg>
          </button>
        </div>
        
        <div className="w-px h-4 bg-slate-700"></div>

        <button onClick={() => { const nextZoom = Math.max(MIN_ZOOM, zoomRef.current - 0.2); zoomRef.current = nextZoom; setZoom(nextZoom); scheduleDraw(); }} className="w-6 h-6 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white transition-all text-sm font-black flex items-center justify-center" title="축소">-</button>
        <span ref={zoomTextRef} className="text-[10px] font-black tracking-wider min-w-[36px] text-center">{Math.round(zoomRef.current * 100)}%</span>
        <button onClick={() => { const nextZoom = Math.min(MAX_ZOOM, zoomRef.current + 0.2); zoomRef.current = nextZoom; setZoom(nextZoom); scheduleDraw(); }} className="w-6 h-6 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white transition-all text-sm font-black flex items-center justify-center" title="확대">+</button>
        <div className="w-px h-3 bg-slate-700"></div>
        <button onClick={() => {
            if (containerRef.current && image) {
              const { clientWidth, clientHeight } = containerRef.current;
              const scale = Math.min((clientWidth - 80) / image.width, (clientHeight - 80) / image.height);
              zoomRef.current = scale;
              offsetRef.current = { x: (clientWidth - image.width * scale) / 2, y: (clientHeight - image.height * scale) / 2 };
              setZoom(scale); setOffset(offsetRef.current); scheduleDraw();
            }
          }} className="px-2 py-0.5 hover:bg-slate-700 rounded-lg text-[9px] font-bold text-blue-400 hover:text-blue-300 transition-all uppercase tracking-wider" title="화면에 맞춤">Fit</button>
      </div>
    </div>
  );
};

export default EditorCanvas;
