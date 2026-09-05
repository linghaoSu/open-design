interface TextInputProps {
  value: string;
  disabled?: boolean;
}

export function TextInput({ value, disabled = false }: TextInputProps) {
  void value;
  void disabled;
  return null;
}

export function TextArea({ value, rows = 3 }: { value: string; rows?: number }) {
  void value;
  void rows;
  return null;
}
