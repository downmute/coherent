export interface LSASItem {
    id: string;
    title: string;
    description: string;
    domain: 'Social' | 'Performance' | 'Observation'; // Simplified domains
}

export const LSAS_QUESTIONS: LSASItem[] = [
    {
        id: 'meeting_new',
        title: 'Meeting someone new',
        description: 'Having a one-on-one conversation with someone you’ve just met (e.g., at a party or event).',
        domain: 'Social'
    },
    {
        id: 'group_convo',
        title: 'Joining a group conversation',
        description: 'Joining a small group that’s already talking and contributing to the conversation.',
        domain: 'Social'
    },
    {
        id: 'video_call',
        title: 'Talking on a video call',
        description: 'Speaking during a small video call (camera on) with people you don’t know very well.',
        domain: 'Performance'
    },
    {
        id: 'center_attention',
        title: 'Being the center of attention',
        description: 'Telling a story about yourself while everyone in a small group is listening to you.',
        domain: 'Performance'
    },
    {
        id: 'speaking_up',
        title: 'Speaking up in a meeting/class',
        description: 'Speaking up to share your opinion in a meeting or class.',
        domain: 'Performance'
    },
    {
        id: 'stranger_intro',
        title: 'Introducing yourself to a stranger',
        description: 'Walking up to someone you don’t know (e.g., at a café/event) and starting a conversation.',
        domain: 'Social'
    },
    {
        id: 'attractive',
        title: 'Talking to someone attractive',
        description: 'Having a casual conversation with someone you find attractive or might want to date.',
        domain: 'Social'
    },
    {
        id: 'favor',
        title: 'Asking for a favor',
        description: 'Asking someone for a small favor (e.g., help with something, minor schedule change).',
        domain: 'Social'
    },
    {
        id: 'feedback',
        title: 'Receiving feedback or criticism',
        description: 'Talking with someone who is giving you feedback or mild criticism about your work or behavior.',
        domain: 'Social'
    },
    {
        id: 'interview',
        title: 'Job interview',
        description: 'Having a job interview or similar high-stakes conversation where you feel judged.',
        domain: 'Performance'
    },
    {
        id: 'eating_public',
        title: 'Eating/drinking in public',
        description: 'Eating or drinking when other people might be watching (e.g., at a café, work lunch).',
        domain: 'Observation'
    },
    {
        id: 'entering_room',
        title: 'Entering a room',
        description: 'Walking into a room where others are already seated.',
        domain: 'Observation'
    }
];

export const FEAR_OPTIONS = ['None (0)', 'Mild (1)', 'Moderate (2)', 'Severe (3)'];
export const AVOIDANCE_OPTIONS = ['Never (0)', 'Occasionally (1)', 'Often (2)', 'Usually (3)'];

export const getSeverityBand = (score: number): { label: string; color: string } => {
    if (score <= 18) return { label: 'Mild Social Anxiety', color: '#4CAF50' };
    if (score <= 30) return { label: 'Moderate Social Anxiety', color: '#FFC107' };
    if (score <= 45) return { label: 'Marked Social Anxiety', color: '#FF9800' };
    if (score <= 60) return { label: 'Severe Social Anxiety', color: '#FF5722' };
    return { label: 'Very Severe Social Anxiety', color: '#F44336' };
};
