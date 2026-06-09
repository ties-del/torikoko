import { render, screen } from '@testing-library/react';
import App from './App';

test('renders login screen', () => {
  render(<App />);
  expect(screen.getByText('とりここ 勤怠管理')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('メールアドレス')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('パスワード')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'ログイン' })).toBeInTheDocument();
});
