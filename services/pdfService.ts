
import { SlideData } from '../types';

declare const pdfjsLib: any;
declare const jspdf: any;

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const MAX_CANVAS_AREA = 5000000; // 5 Megapixels

export const convertPdfToImages = async (
  file: File,
  onProgress?: (current: number, total: number) => void
): Promise<SlideData[]> => {
  const fileUrl = URL.createObjectURL(file);
  let pdf: any = null;
  const slides: SlideData[] = [];

  try {
    const loadingTask = pdfjsLib.getDocument({ url: fileUrl });
    pdf = await loadingTask.promise;

    for (let i = 1; i <= pdf.numPages; i++) {
      let page: any = null;
      try {
        page = await pdf.getPage(i);
        
        // 1. 동적 스케일링 (Max 5MP Area)
        let scale = 2.0;
        let viewport = page.getViewport({ scale });
        const area = viewport.width * viewport.height;
        
        if (area > MAX_CANVAS_AREA) {
          const baseViewport = page.getViewport({ scale: 1.0 });
          scale = Math.sqrt(MAX_CANVAS_AREA / (baseViewport.width * baseViewport.height));
          scale = Math.min(scale, 2.0);
          viewport = page.getViewport({ scale });
        }

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { willReadFrequently: true });
        
        let renderSuccess = false;
        let currentScale = scale;
        
        // 2. OOM 방어 폴백 (Retry)
        while (currentScale >= 0.5 && !renderSuccess) {
          canvas.height = viewport.height;
          canvas.width = viewport.width;
          
          try {
            await page.render({ canvasContext: context, viewport }).promise;
            renderSuccess = true;
          } catch (e) {
            console.warn(`[PDF] 렌더링 실패 (scale: ${currentScale}), 해상도를 낮춰 재시도합니다.`, e);
            if (currentScale <= 0.5) break;
            currentScale -= 0.5;
            viewport = page.getViewport({ scale: currentScale });
          }
        }

        if (renderSuccess) {
          // 3. Base64 메모리 폭발 해체 (Blob Object URL)
          const blobUrl = await new Promise<string>((resolve, reject) => {
            canvas.toBlob((blob) => {
              if (blob) {
                resolve(URL.createObjectURL(blob));
              } else {
                reject(new Error('Canvas to Blob conversion failed'));
              }
            }, 'image/jpeg', 0.9); // JPEG로 메모리 추가 절약
          });

          slides.push({
            index: i - 1,
            dataUrl: blobUrl,
            width: viewport.width,
            height: viewport.height,
            overlays: []
          });
        }
      } catch (e) {
        console.error(`[PDF] 페이지 ${i} 변환 중 치명적 오류:`, e);
      } finally {
        // 4. 페이지 메모리 해제 (Memory Leak Fix)
        if (page && typeof page.cleanup === 'function') {
          page.cleanup();
        }
      }

      if (onProgress) {
        onProgress(i, pdf.numPages);
      }
      // 5. Watchdog Kill 방어 (Macrotask Yielding)
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } catch (error) {
    console.error('PDF 로드 실패:', error);
    throw error;
  } finally {
    // 6. PDF 인스턴스 메모리 해제 및 URL Revoke
    if (pdf && typeof pdf.destroy === 'function') {
      pdf.destroy();
    }
    URL.revokeObjectURL(fileUrl);
  }

  return slides;
};

export const downloadAsPdf = (slides: SlideData[], filename: string) => {
  const { jsPDF } = jspdf;
  const doc = new jsPDF({
    orientation: slides[0].width > slides[0].height ? 'landscape' : 'portrait',
    unit: 'px',
    format: [slides[0].width, slides[0].height]
  });

  const processSlide = async (slide: SlideData, idx: number) => {
    if (idx > 0) doc.addPage([slide.width, slide.height]);
    
    const canvas = document.createElement('canvas');
    canvas.width = slide.width;
    canvas.height = slide.height;
    const ctx = canvas.getContext('2d')!;
    
    const img = new Image();
    img.src = slide.dataUrl;
    await new Promise(resolve => img.onload = resolve);
    
    ctx.drawImage(img, 0, 0);

    slide.overlays.forEach(overlay => {
      ctx.fillStyle = overlay.backgroundColor;
      ctx.fillRect(overlay.rect.x, overlay.rect.y, overlay.rect.width, overlay.rect.height);
      
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
    
    const finalDataUrl = canvas.toDataURL('image/jpeg', 0.95);
    doc.addImage(finalDataUrl, 'JPEG', 0, 0, slide.width, slide.height);
  };

  const saveAll = async () => {
    for (let i = 0; i < slides.length; i++) {
      await processSlide(slides[i], i);
    }
    doc.save(filename);
  };

  saveAll();
};
