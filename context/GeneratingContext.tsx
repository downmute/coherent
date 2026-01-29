import React, { createContext, ReactNode, useState } from 'react';

interface GeneratingContextType {
    isGlobalGenerating: boolean;
    setGlobalGenerating: (generating: boolean) => void;
}

export const GeneratingContext = createContext<GeneratingContextType>({
    isGlobalGenerating: false,
    setGlobalGenerating: () => { },
});

export const GeneratingProvider = ({ children }: { children: ReactNode }) => {
    const [isGlobalGenerating, setGlobalGenerating] = useState(false);

    return (
        <GeneratingContext.Provider value={{ isGlobalGenerating, setGlobalGenerating }}>
            {children}
        </GeneratingContext.Provider>
    );
};
