# Chunked Upload Implementation

## Overview
This implementation adds automatic file splitting and chunked uploads for large documents (PDF, DOCX, PPTX) to handle Vercel's 4.5MB request body limit.

## Problem Solved
Previously, uploading files larger than ~4.5MB would fail with a 413 error from Vercel. Now, large files are automatically:
1. **Parsed in the browser** to extract text content
2. **Split into chunks** if the text is very long
3. **Uploaded in multiple parts** (~4MB each)
4. **Merged back together** into a single study set

## How It Works

### For Large Documents (>4MB):
1. **Client-side text extraction** - The file is read in the browser using:
   - PDFs: `pdf.js` (already existed)
   - DOCX: `mammoth` (new client-side implementation)
   - PPTX: `JSZip` (new client-side implementation)

2. **Text chunking** - If extracted text exceeds 90,000 characters, it's split at paragraph/sentence boundaries into multiple parts

3. **Multi-part upload** - Each part is sent as a separate API call:
   - Part 1: Binary files (images, small docs) + first text chunk
   - Part 2+: Additional text chunks only
   - Brief pause (500ms) between parts to avoid rate limits

4. **Result merging** - All flashcards from all parts are combined into one study set

### For Small Documents (≤4MB):
- Uploaded as binary (existing behavior)
- Processed server-side as before

## Files Modified

### New Files:
1. **`src/lib/docx-client.ts`** - Client-side Word document text extraction
2. **`src/lib/pptx-client.ts`** - Client-side PowerPoint text extraction

### Modified Files:
1. **`src/app/page.tsx`**:
   - Added imports for new client-side extractors
   - Added `splitTextIntoChunks()` helper function
   - Added `DOC_DIRECT_UPLOAD_BUDGET` constant (4MB)
   - Added `TEXT_CHUNK_MAX_CHARS` constant (90,000 chars)
   - Modified `handleSubmit()` to:
     - Extract text from large DOCX/PPTX files client-side
     - Split text into chunks when needed
     - Make multiple sequential API calls
     - Merge results from all parts
   - Updated UI to show chunked upload progress
   - Updated upload page description

## User Experience

### Progress Messages:
- **"Reading 'document.pdf' — page 5 of 20..."** - During PDF text extraction
- **"Reading 'slides.pptx' — slide 3 of 15..."** - During PPTX text extraction
- **"Reading 'document.docx' (16.5 MB)..."** - During DOCX text extraction
- **"Large file detected! Uploading in 4 parts (~4 MB each)..."** - When chunking begins
- **"Uploading part 2 of 4..."** - During multi-part upload
- **"Generated 45 flashcards from 4 parts!"** - Success message for chunked uploads

### Visual Indicators:
- Status text appears in the upload button during processing
- Special banner appears for multi-part uploads showing current part
- Progress is shown throughout the entire process

## Technical Details

### Constants:
```typescript
PDF_DIRECT_UPLOAD_BUDGET = 4 * 1024 * 1024  // 4MB
DOC_DIRECT_UPLOAD_BUDGET = 4 * 1024 * 1024  // 4MB (same as PDF)
DIRECT_UPLOAD_HARD_CAP = 4.4 * 1024 * 1024  // 4.4MB (absolute ceiling)
TEXT_CHUNK_MAX_CHARS = 90_000               // Chars per chunk
```

### Text Splitting Algorithm:
1. Split text at paragraph boundaries (`\n\n+`)
2. If a paragraph exceeds chunk size, split at sentence boundaries (`.`, `!`, `?`)
3. Ensure each chunk stays under 90,000 characters
4. Preserve document structure as much as possible

### Error Handling:
- If client-side extraction fails, falls back to server-side processing (if file fits)
- If one part of a multi-part upload fails, the entire upload fails with a clear error
- Password-protected PDFs are detected and reported
- Scanned PDFs (no text layer) are handled gracefully

### Rate Limiting:
- 500ms pause between multi-part uploads to avoid hitting API rate limits
- Each part includes a label: `[Part X of Y — generate flashcards for this section]`
- This helps the AI understand it's processing a fragment of a larger document

## Benefits

1. **No more 413 errors** - Large files are handled automatically
2. **Better UX** - Clear progress messages throughout the process
3. **Maintains quality** - Text extraction preserves document content
4. **Works for all document types** - PDF, DOCX, and PPTX all supported
5. **Backward compatible** - Small files still use the existing fast path
6. **No server-side changes needed** - All processing happens client-side

## Limitations

1. **Scanned PDFs** - Large scanned PDFs (image-only, no text layer) still can't be uploaded if they exceed 4.4MB
2. **Very large documents** - Documents with >100,000 characters of text are truncated (existing limitation)
3. **Multiple API calls** - Chunked uploads make multiple requests, which takes longer and uses more API quota
4. **No progress bar** - Progress is shown as text, not a visual progress bar (could be enhanced later)

## Testing Recommendations

1. Upload a 16MB PDF with text content
2. Upload a 10MB DOCX file
3. Upload a 12MB PPTX file with 50+ slides
4. Upload multiple large files together
5. Upload a mix of large documents and images
6. Test with a scanned PDF (should show appropriate error if too large)
7. Test with a password-protected PDF (should show error message)

## Future Enhancements

1. **Visual progress bar** - Show a progress bar for multi-part uploads
2. **Retry logic** - Automatically retry failed parts
3. **Parallel uploads** - Upload multiple parts in parallel (with rate limiting)
4. **Scanned PDF splitting** - Split large scanned PDFs into page images
5. **Compression** - Compress extracted text before upload
6. **Caching** - Cache extracted text to avoid re-processing the same file
