import type { RecognitionMode } from './protocol';

export const recognitionInstructions = {
  auto: 'Transcribe the image in reading order. Preserve normal text and spaces. Write mathematical expressions in LaTeX, using $...$ for inline math and $$...$$ for standalone equations. Output only the transcription.',
  equation: 'Please write out the expression of the formula in the image using LaTeX format.',
  mixed: 'Please output the text content from the image.',
} satisfies Record<RecognitionMode, string>;
