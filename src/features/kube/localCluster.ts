import { createContext, useContext } from 'react';

/**
 * Whether this workspace runs kubectl on this computer rather than on a server. Only what the
 * screen says differs, so it is read where the words are instead of passed through every panel.
 */
export const LocalCluster = createContext(false);
export const useLocalCluster = () => useContext(LocalCluster);
