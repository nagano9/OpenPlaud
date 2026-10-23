/**
 * Recording formats the vault accepts, for file pickers. Mirrors AUDIO_EXTENSIONS and
 * CONVERTIBLE_AUDIO_EXTENSIONS in src/library/recording-library.ts: MP3, M4A, WAV, OGG, WebM, AAC
 * and FLAC are stored as they are; the rest are converted to M4A with the original kept.
 */
export const RECORDING_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.ogg', '.webm', '.aac', '.flac', '.opus', '.oga', '.amr', '.awb', '.3gp', '.3g2', '.3ga',
  '.m4b', '.m4r', '.wma', '.aif', '.aiff', '.aifc', '.caf', '.mka', '.ac3', '.mp2', '.mpga', '.mp4', '.m4v', '.mov', '.mkv'] as const

/** `accept` attribute: MIME families plus extensions, since browsers label phone formats inconsistently. */
export const RECORDING_ACCEPT = ['audio/*', 'video/mp4', 'video/3gpp', 'video/quicktime', 'video/webm', 'video/x-matroska', ...RECORDING_EXTENSIONS].join(',')

export const isRecordingFile = (name: string) => RECORDING_EXTENSIONS.some(extension => name.toLowerCase().endsWith(extension))
