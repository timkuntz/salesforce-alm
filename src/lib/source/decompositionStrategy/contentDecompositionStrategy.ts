/*
 * Copyright, 1999-2017, salesforce.com
 * All Rights Reserved
 * Company Confidential
 */

/**
 * Contract for where and how content files will be decomposed and saved to the workspace
 */

export interface ContentDecompositionStrategy {
  /**
   * Gets the list of paths to content files in the workspace for the given metadata entity
   * @param metadataFilePath
   */
  getContentPaths(metadataFilePath: string): string[];

  /**
   *
   * @param metadataFilePath - the nondecomposed metadata path for the given metadata entity
   * @param retrievedContentFilePaths - the paths to the files from which the content will be copied/extracted
   * @param retrievedMetadataFilePath - the path to the retrieved metadata file
   * @param createDuplicates - whether to create .dup files in case there are identical existing content files
   * @param unsupportedMimeTypes - list of static resource mime types that are not allowlisted for support
   * @param forceoverwrite - force an overwrite
   */
  saveContent(
    metadataFilePath: string,
    retrievedContentFilePaths: string[],
    retrievedMetadataFilePath: string,
    createDuplicates: boolean,
    unsupportedMimeTypes: string[],
    forceoverwrite: boolean
  ): [string[], string[], string[], string[]];
}
