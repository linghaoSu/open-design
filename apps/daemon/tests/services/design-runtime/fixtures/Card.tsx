type CardProps = {
  heading: string;
  elevation?: 0 | 1 | 2;
};

export const Card = ({ heading, elevation = 0 }: CardProps) => {
  void heading;
  void elevation;
  return null;
};
